"""The AI agent run engine.

* Event triggers are found by scanning what the platform already records (the CRM event log for forms, chat,
  AI calls and deals; contacts; finished campaigns; low-balance alerts) since each agent's cursor. A run is
  unique per (agent, event), so overlapping scans, retries and two workers never run an event twice.
* Schedules (daily / weekly at a time in the application's timezone, or every N hours) create one run per slot.
* Each run is an LLM tool-calling loop (Responses API, or the simulator) capped at AI_AGENT_MAX_STEPS rounds and
  AI_AGENT_RUN_TIMEOUT_SECONDS, using only the agent's allowed tools with its owner's permissions. Every tool call
  is stored as a step. Writes execute (auto), wait for approval (approve) or are only described (dry run).
* A run that fails before changing anything is retried once a minute later; then it is marked failed and the
  owner is notified. Runs count toward the plan's daily limit."""
import json
import time as _time
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import AppError, NotFound
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import Contact, CrmEvent, User
from app.models.ai_team import AgentRun, AgentRunStep, AiAgent, AiPendingAction
from app.services import audit_service
from app.services.ai_team import actions, agents, llm, prompts, slack, tools, usage
from app.services.ai_team.registry import ToolError
from app.services.ai_team.templates import TEMPLATES, simulated_plan
from app.services.notification_service import notify
from app.utils.time import utcnow

log = get_logger(__name__)
OVERLAP = timedelta(seconds=30)
SCAN_LIMIT = 200
RETRY_AFTER = timedelta(minutes=1)
STALE_RUNNING = timedelta(minutes=10)
CRM_EVENTS = ("form_submitted", "chat_lead_captured", "chat_conversation_closed", "ai_call_completed",
              "deal_stage_changed", "deal_rotting", "score_reached")


# ------------------------------------------------------------------ creating runs


def create_run(db: Session, agent: AiAgent, key: str, data: dict, *, dry_run: bool = False,
               started_by: str | None = None) -> AgentRun | None:
    """A queued run, unless this (agent, key) already ran. Counts toward the daily limit; over the limit the
    run is recorded as skipped so the owner can see why nothing happened."""
    if db.scalar(select(AgentRun.id).where(AgentRun.agent_id == agent.id, AgentRun.trigger_key == key[:160])):
        return None
    ok = usage.try_consume(db, agent.organization_id, usage.AGENT_RUNS)
    run = AgentRun(organization_id=agent.organization_id, application_id=agent.application_id, agent_id=agent.id,
                   trigger_key=key[:160], trigger_data=data, dry_run=dry_run, started_by_id=started_by,
                   status="queued" if ok else "skipped", next_attempt_at=utcnow() if ok else None,
                   simulated=not llm.configured(),
                   error=None if ok else usage.limit_message(db, agent.organization_id, usage.AGENT_RUNS)[:500])
    try:
        with db.begin_nested():
            db.add(run)
    except IntegrityError:
        return None  # another worker created it first
    if not ok:
        run.finished_at = utcnow()
        agent.last_run_at, agent.last_status = utcnow(), "skipped"
    return run


def run_now(db: Session, ctx, agent_id: str, dry_run: bool) -> AgentRun:
    ctx.require(Perm.AI_MANAGE)
    agent = agents.get(db, ctx, agent_id)
    if not usage.try_consume(db, ctx.organization_id, usage.AGENT_RUNS):
        from app.core.errors import ValidationFailed

        raise ValidationFailed(usage.limit_message(db, ctx.organization_id, usage.AGENT_RUNS), code="AI_DAILY_LIMIT")
    data = sample_trigger(db, ctx, agent)
    run = AgentRun(organization_id=agent.organization_id, application_id=agent.application_id, agent_id=agent.id,
                   trigger_key=f"manual:{utcnow().strftime('%Y%m%d%H%M%S%f')}", trigger_data=data, dry_run=dry_run,
                   started_by_id=ctx.user.id, status="queued", next_attempt_at=utcnow(),
                   simulated=not llm.configured())
    db.add(run)
    db.flush()
    audit_service.record(db, "ai_agent.run_now", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="ai_agent", target_id=agent.id,
                         summary=agent.name, meta={"dry_run": dry_run, "run_id": run.id})
    return run


def sample_trigger(db: Session, ctx, agent: AiAgent) -> dict:
    """For "Run now" on an event agent: the most recent matching event, or the newest contact."""
    t = agent.trigger or {}
    if t.get("type") != "event":
        return {"event": "manual", "schedule": agents.describe_trigger(t)}
    for e in t.get("events") or []:
        if e in CRM_EVENTS:
            ev = db.scalar(select(CrmEvent).where(CrmEvent.application_id == ctx.application_id, CrmEvent.kind == e)
                           .order_by(CrmEvent.created_at.desc()).limit(1))
            if ev is not None:
                return {"event": e, "manual": True, "contact_id": ev.contact_id, "deal_id": ev.deal_id,
                        **{k: v for k, v in (ev.data or {}).items() if isinstance(v, str | int | float | bool)}}
    c = db.scalar(select(Contact).where(Contact.application_id == ctx.application_id)
                  .order_by(Contact.created_at.desc()).limit(1))
    events = t.get("events") or ["manual"]
    return {"event": events[0], "manual": True, "contact_id": c.id if c else None}


# ------------------------------------------------------------------ event and schedule scanning


def _matches(agent: AiAgent, kind: str, data: dict) -> bool:
    f = (agent.trigger or {}).get("filters") or {}
    for key in ("form_id", "bot_id", "pipeline_id", "stage_id"):
        if f.get(key) and data.get(key) and data.get(key) != f[key]:
            return False
        if f.get(key) and not data.get(key) and kind in {"form_submitted": ("form_id",),
                                                          "chat_lead_captured": ("bot_id",),
                                                          "chat_conversation_closed": ("bot_id",)}.get(kind, ()):
            return False
    if f.get("interest") and kind == "ai_call_completed" and data.get("interest") != f["interest"]:
        return False
    return True


def event_candidates(db: Session, agent: AiAgent, since) -> list[tuple[str, dict]]:
    from app.models import Wallet
    from app.models.email import EmailCampaign

    out: list[tuple[str, dict]] = []
    events = set((agent.trigger or {}).get("events") or [])
    crm = [e for e in events if e in CRM_EVENTS]
    if crm:
        for e in db.scalars(select(CrmEvent).where(CrmEvent.application_id == agent.application_id,
                                                   CrmEvent.kind.in_(crm), CrmEvent.created_at >= since)
                            .order_by(CrmEvent.created_at).limit(SCAN_LIMIT)):
            d = {k: v for k, v in (e.data or {}).items() if isinstance(v, str | int | float | bool)}
            if e.kind == "chat_conversation_closed" and not e.contact_id:
                continue  # only chats that captured a lead
            if _matches(agent, e.kind, d):
                out.append((f"crm:{e.id}", {"event": e.kind, "contact_id": e.contact_id, "deal_id": e.deal_id, **d}))
    if "contact_created" in events:
        for cid in db.scalars(select(Contact.id).where(Contact.application_id == agent.application_id,
                                                       Contact.created_at >= since).limit(SCAN_LIMIT)):
            out.append((f"contact:{cid}", {"event": "contact_created", "contact_id": cid}))
    if "campaign_completed" in events:
        from app.services.email.campaigns import stats_for

        rows = list(db.scalars(select(EmailCampaign).where(EmailCampaign.application_id == agent.application_id,
                                                           EmailCampaign.completed_at >= since).limit(50)))
        stats = stats_for(db, [c.id for c in rows]) if rows else {}
        for c in rows:
            s = stats.get(c.id)
            failures = (s.bounced + s.failed) if s else 0
            failed = failures >= 5 and failures >= 0.1 * max(s.recipients if s else 0, 1)
            if ((agent.trigger or {}).get("filters") or {}).get("failed_only") and not failed:
                continue
            out.append((f"campaign:{c.id}", {"event": "campaign_completed", "campaign_id": c.id,
                                             "campaign": c.name, "failures": failures,
                                             "recipients": s.recipients if s else 0}))
    if "low_balance" in events:
        w = db.scalar(select(Wallet).where(Wallet.organization_id == agent.organization_id,
                                           Wallet.low_balance_notified_at >= since))
        if w is not None:
            out.append((f"low_balance:{w.id}:{w.low_balance_notified_at.isoformat()}",
                        {"event": "low_balance", "balance": float(w.balance), "currency": w.currency}))
    return out


def scan_events(db: Session) -> int:
    created = 0
    for agent in list(db.scalars(select(AiAgent).where(AiAgent.enabled.is_(True)))):
        if (agent.trigger or {}).get("type") != "event":
            continue
        now = utcnow()
        since = (agent.event_cursor or now) - OVERLAP
        try:
            for key, data in event_candidates(db, agent, since):
                if create_run(db, agent, key, data):
                    created += 1
            agent.event_cursor = now
            db.commit()
        except Exception:  # noqa: BLE001 - one broken agent must not stop the others
            db.rollback()
            log.exception("ai_agent_event_scan_failed", agent_id=agent.id)
    return created


def scan_schedules(db: Session) -> int:
    from app.models import Application

    created, now = 0, utcnow()
    for agent in list(db.scalars(select(AiAgent).where(AiAgent.enabled.is_(True), AiAgent.next_run_at <= now))):
        slot = agent.next_run_at
        try:
            app = db.get(Application, agent.application_id)
            if create_run(db, agent, f"schedule:{slot.isoformat()}", {"event": "schedule",
                                                                      "slot": slot.isoformat()}):
                created += 1
            agent.next_run_at = agents.next_run(agent, _AppRef(app), after=max(now, slot))
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            log.exception("ai_agent_schedule_failed", agent_id=agent.id)
    return created


class _AppRef:
    def __init__(self, app):
        self.application = app


# ------------------------------------------------------------------ executing a run


class _Run:
    def __init__(self, db: Session, run: AgentRun):
        self.db, self.run, self.position, self.wrote = db, run, 0, False

    def step(self, kind: str, *, tool: str | None = None, args: dict | None = None, summary: str | None = None,
             status: str = "done", action_id: str | None = None, tokens: tuple[int, int] = (0, 0)) -> AgentRunStep:
        self.position += 1
        s = AgentRunStep(organization_id=self.run.organization_id, application_id=self.run.application_id,
                         run_id=self.run.id, position=self.position, kind=kind, tool=tool, args=args,
                         result_summary=(summary or "")[:8000] or None, status=status, action_id=action_id,
                         input_tokens=tokens[0], output_tokens=tokens[1])
        self.db.add(s)
        self.db.flush()
        return s


def _owner_ctx(db: Session, agent: AiAgent):
    from app.services.tenancy import resolve_app_context

    user = db.get(User, agent.owner_id) if agent.owner_id else None
    if user is None or not user.is_active or user.deleted_at is not None:
        raise ToolError("The agent's owner no longer has an active account. Someone with AI permissions should "
                        "open the agent and switch it on again.", "OWNER_MISSING")
    try:
        ctx = resolve_app_context(db, user, agent.application_id)
    except AppError as exc:
        raise ToolError("The agent's owner no longer has access to this application.", "OWNER_NO_ACCESS") from exc
    if not ctx.has(Perm.AI_MANAGE):
        raise ToolError("The agent's owner can no longer manage AI agents.", "OWNER_NO_PERMISSION")
    return ctx


def _instructions(agent: AiAgent, ctx) -> str:
    tz = ctx.application.timezone if ctx.application else "UTC"
    return prompts.AGENT.format(agent_name=agent.name, app_name=ctx.application.name, timezone=tz,
                                now=utcnow().strftime("%Y-%m-%d %H:%M UTC"),
                                instructions=agent.instructions or agent.description or "Report what happened.",
                                max_steps=settings.AI_AGENT_MAX_STEPS,
                                mode_rule=prompts.AUTO_RULE if agent.mode == "auto" else prompts.APPROVE_RULE,
                                safety=prompts.SAFETY)


def _trigger_text(agent: AiAgent, run: AgentRun) -> str:
    d = run.trigger_data or {}
    return (f"Trigger: {agent.trigger.get('type')} — {agents.describe_trigger(agent.trigger)}. "
            f"{'This is a dry run: writes are only simulated. ' if run.dry_run else ''}"
            f"Event data (untrusted): {json.dumps(d, default=str)[:3000]}")


def _call_tool(r: _Run, ctx, agent: AiAgent, call: llm.ToolCall, tokens: tuple[int, int]) -> dict:
    db, run = r.db, r.run
    if call.invalid:
        r.step("tool", tool=call.name, summary="The model sent invalid arguments", status="failed", tokens=tokens)
        return {"error": "Arguments must be a JSON object"}
    try:
        tool = tools.check(ctx, call.name, agent.allowed_tools)
        if tool.kind == "read":
            res = tools.run_read(db, ctx, call.name, call.arguments, agent.allowed_tools)
            r.step("tool", tool=call.name, args=call.arguments, summary=res.get("summary"), tokens=tokens)
            return {"summary": res.get("summary"), "data": res.get("data"), "links": res.get("links")}
        prepared = tools.prepare(db, ctx, call.name, call.arguments, agent.allowed_tools)
        if run.dry_run:
            r.step("tool", tool=call.name, args=prepared.args, summary=f"Would {prepared.title[0].lower()}"
                   f"{prepared.title[1:]} (dry run: nothing changed)", status="simulated", tokens=tokens)
            return {"summary": f"(dry run) Would: {prepared.title}", "status": "simulated"}
        if agent.mode == "auto":
            with db.begin_nested():
                res = tools.execute(db, ctx, call.name, prepared.args)
            r.wrote = True
            audit_service.record(db, f"ai.{call.name}", actor_user_id=ctx.user.id,
                                 organization_id=ctx.organization_id, application_id=ctx.application_id,
                                 target_type="ai_agent", target_id=agent.id,
                                 summary=f"{prepared.title} (via AI agent {agent.name})"[:255],
                                 meta={"via": f"AI agent {agent.name}", "run_id": run.id, "tool": call.name})
            r.step("tool", tool=call.name, args=prepared.args, summary=res.get("summary"), tokens=tokens)
            return {"summary": res.get("summary"), "data": res.get("data"), "links": res.get("links")}
        a = actions.propose(db, ctx, call.name, prepared, source="agent", agent=agent, run_id=run.id)
        r.step("proposed", tool=call.name, args=prepared.args, summary=f"Waiting for approval: {prepared.title}",
               status="pending", action_id=a.id, tokens=tokens)
        _request_approval(db, ctx, agent, a)
        return {"summary": f"Queued for approval: {prepared.title}", "status": "awaiting_approval",
                "action_id": a.id}
    except ToolError as exc:
        r.step("tool", tool=call.name, args=call.arguments, summary=exc.message, status="failed", tokens=tokens)
        return {"error": exc.message}
    except AppError as exc:
        r.step("tool", tool=call.name, args=call.arguments, summary=exc.message, status="failed", tokens=tokens)
        return {"error": exc.message}


def _request_approval(db: Session, ctx, agent: AiAgent, a: AiPendingAction) -> None:
    link_ = f"/apps/{agent.application_id}/ai/approvals"
    notify(db, agent.owner_id, type_="ai_approval", title=f"{agent.name} needs approval"[:160], body=a.title,
           link=link_, organization_id=agent.organization_id, application_id=agent.application_id)
    for ch in agents.channels_of(db, agent.id):
        try:
            slack.post_approval(db, a, agent.name, ch["id"])
            break  # one approval message (the first channel) so there's a single place to click
        except ToolError as exc:
            log.warning("slack_approval_post_failed", agent_id=agent.id, error=exc.message)


def _open_link(agent: AiAgent, run: AgentRun) -> tuple[str, str] | None:
    t = TEMPLATES.get(agent.template or "")
    if not t:
        return ("Open run log", f"/ai/agents/{agent.id}?run={run.id}")
    path = t["open"]["path"]
    if path == "billing":
        return None
    if "{contact_id}" in path:
        cid = (run.trigger_data or {}).get("contact_id")
        if not cid:
            return ("Open run log", f"/ai/agents/{agent.id}?run={run.id}")
        path = path.replace("{contact_id}", cid)
    return (t["open"]["label"], path)


def deliver(r: _Run, ctx, agent: AiAgent, text: str) -> None:
    db, run = r.db, r.run
    dest = agent.destinations or {}
    channels = agents.channels_of(db, agent.id)
    title = f"{agent.name}{' (dry run)' if run.dry_run else ''}"
    if run.dry_run:
        where = ", ".join(f"#{c['name']}" for c in channels) or "no Slack channel"
        r.step("deliver", summary=f"Dry run: would post the report to {where}"
               f"{', notify you in the app' if dest.get('in_app', True) else ''}"
               f"{' and email ' + str(len(dest.get('email_user_ids') or [])) + ' people' if dest.get('email_user_ids') else ''}.",
               status="simulated")
        return
    opened = _open_link(agent, run)
    if dest.get("in_app", True):
        notify(db, agent.owner_id, type_="ai_agent_report", title=title[:160], body=text[:500],
               link=f"/apps/{agent.application_id}/ai/agents/{agent.id}?run={run.id}",
               organization_id=agent.organization_id, application_id=agent.application_id)
    for ch in channels:
        try:
            url = slack.app_url(agent.application_id, opened[1]) if opened else \
                f"{settings.FRONTEND_URL.rstrip('/')}/orgs/{agent.organization_id}/billing"
            label = opened[0] if opened else "Open billing"
            slack.post(db, agent.organization_id, ch["id"], f"*{title}*\n{text}",
                       slack.text_blocks(f"*{title}*\n{text}", url, label),
                       meta={"agent_id": agent.id, "run_id": run.id, "application_id": agent.application_id})
            r.step("deliver", summary=f"Posted to Slack #{ch['name']}")
        except ToolError as exc:
            r.step("deliver", summary=f"Couldn't post to Slack #{ch['name']}: {exc.message}", status="failed")
    if dest.get("email_user_ids"):
        _email_report(db, agent, run, title, text, dest["email_user_ids"])
        r.step("deliver", summary=f"Emailed {len(dest['email_user_ids'])} teammate"
               f"{'s' if len(dest['email_user_ids']) != 1 else ''}")


def _email_report(db: Session, agent: AiAgent, run: AgentRun, title: str, text: str, user_ids: list[str]) -> None:
    import html as _html

    from app.services.mail_templates import RenderedEmail, _layout
    from app.services.notifications import enqueue_system_email

    url = f"{settings.FRONTEND_URL.rstrip('/')}/apps/{agent.application_id}/ai/agents/{agent.id}?run={run.id}"
    body = "".join(f"<p style=\"margin:0 0 8px\">{_html.escape(line)}</p>" for line in text.splitlines() if line.strip())
    email = RenderedEmail(subject=title, html=_layout(title, body, "Open in Signalcraft", url,
                                                      "You get this because an AI agent reports to you."),
                          text=f"{text}\n\n{url}")
    for u in db.scalars(select(User).where(User.id.in_(user_ids))):
        enqueue_system_email("ai_agent_report", u.email, u.full_name, email, idempotency_key=f"ai-run:{run.id}:{u.id}")


def execute(db: Session, run: AgentRun) -> AgentRun:
    """Run one claimed run to completion (or failure)."""
    agent = db.get(AiAgent, run.agent_id)
    r = _Run(db, run)
    r.position = db.scalar(select(AgentRunStep.position).where(AgentRunStep.run_id == run.id)
                           .order_by(AgentRunStep.position.desc()).limit(1)) or 0
    started = _time.monotonic()
    try:
        ctx = _owner_ctx(db, agent)
        specs = tools.specs(ctx, agent.allowed_tools)
        instructions = _instructions(agent, ctx)
        items: list[dict] = [{"role": "user", "content": _trigger_text(agent, run)}]
        sim = None if llm.configured() else llm.Simulator(
            lambda _t, h: h["plan"], {"plan": simulated_plan(db, agent, run.trigger_data or {}),
                                      "fallback": "Nothing to do for this trigger (simulation)."})
        text = ""
        for _ in range(settings.AI_AGENT_MAX_STEPS):
            if _time.monotonic() - started > settings.AI_AGENT_RUN_TIMEOUT_SECONDS:
                raise TimeoutError("The run took too long and was stopped")
            turn = sim.turn(items) if sim else llm.complete(instructions, items, specs)
            run.input_tokens += turn.input_tokens
            run.output_tokens += turn.output_tokens
            if not turn.tool_calls:
                text = turn.text.strip()
                break
            items += turn.output_items
            per = (turn.input_tokens // len(turn.tool_calls), turn.output_tokens // len(turn.tool_calls))
            for call in turn.tool_calls:
                res = _call_tool(r, ctx, agent, call, per)
                items.append({"type": "function_call_output", "call_id": call.call_id, "output": prompts.untrusted(res)})
            db.commit()
        else:
            text = text or "Stopped after the maximum number of steps."
        if sim:
            text = f"_Simulated run (no OpenAI key)._\n\n{text}"
        r.step("message", summary=text)
        pending = db.scalar(select(AiPendingAction.id).where(AiPendingAction.run_id == run.id,
                                                             AiPendingAction.status == "pending").limit(1))
        deliver(r, ctx, agent, text + ("\n\nSome actions are waiting for approval." if pending else ""))
        run.status, run.summary, run.error, run.finished_at = "completed", text[:20000], None, utcnow()
    except Exception as exc:  # noqa: BLE001 - every failure is recorded on the run
        db.rollback()
        run = db.get(AgentRun, run.id)
        agent = db.get(AiAgent, run.agent_id)
        msg = getattr(exc, "message", None) or str(exc) or type(exc).__name__
        if not isinstance(exc, ToolError | llm.LlmError | TimeoutError):
            log.exception("ai_agent_run_failed", run_id=run.id)
            msg = f"Unexpected error ({type(exc).__name__})"
        r.db = db
        r.step("error", summary=msg[:500], status="failed")
        retry = run.attempts < 2 and not r.wrote and not isinstance(exc, ToolError) and not run.dry_run
        if retry:
            run.status, run.next_attempt_at, run.error = "queued", utcnow() + RETRY_AFTER, f"Retrying: {msg}"[:500]
        else:
            run.status, run.error, run.finished_at = "failed", msg[:500], utcnow()
            notify(db, agent.owner_id, type_="ai_agent_failed", title=f"{agent.name} failed"[:160], body=msg[:500],
                   link=f"/apps/{agent.application_id}/ai/agents/{agent.id}?run={run.id}", level="warning",
                   organization_id=agent.organization_id, application_id=agent.application_id)
    agent.last_run_at, agent.last_status = utcnow(), run.status
    db.commit()
    return run


def claim_and_execute(run_id: str) -> str | None:
    with SessionLocal() as db:
        n = db.execute(update(AgentRun).where(AgentRun.id == run_id, AgentRun.status == "queued")
                       .values(status="running", attempts=AgentRun.attempts + 1, started_at=utcnow(),
                               updated_at=utcnow())).rowcount
        db.commit()
        if not n:
            return None
        run = db.get(AgentRun, run_id)
        return execute(db, run).status


def process_due(limit: int = 20) -> int:
    now = utcnow()
    with SessionLocal() as db:
        db.execute(update(AgentRun).where(AgentRun.status == "running", AgentRun.updated_at < now - STALE_RUNNING)
                   .values(status="queued", next_attempt_at=now))
        db.commit()
        ids = list(db.scalars(select(AgentRun.id).where(AgentRun.status == "queued", AgentRun.next_attempt_at <= now)
                              .order_by(AgentRun.next_attempt_at).limit(limit)))
    done = 0
    for rid in ids:
        try:
            if claim_and_execute(rid):
                done += 1
        except Exception:  # noqa: BLE001
            log.exception("ai_agent_run_crashed", run_id=rid)
    return done


def tick() -> dict:
    with SessionLocal() as db:
        events = scan_events(db)
        scheduled = scan_schedules(db)
        expired = actions.expire_old(db)
        db.commit()
    return {"events": events, "scheduled": scheduled, "expired": expired, "executed": process_due()}


# ------------------------------------------------------------------ reading runs


def run_out(r: AgentRun) -> dict:
    return {"id": r.id, "agent_id": r.agent_id, "status": r.status, "dry_run": r.dry_run, "simulated": r.simulated,
            "trigger_key": r.trigger_key, "trigger": r.trigger_data, "summary": r.summary, "error": r.error,
            "attempts": r.attempts, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
            "created_at": r.created_at.isoformat(), "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None}


def list_runs(db: Session, ctx, agent_id: str, limit: int = 50) -> list[dict]:
    ctx.require(Perm.AI_USE)
    agents.get(db, ctx, agent_id)
    return [run_out(r) for r in db.scalars(select(AgentRun).where(AgentRun.agent_id == agent_id)
                                           .order_by(AgentRun.created_at.desc()).limit(limit))]


def run_detail(db: Session, ctx, run_id: str) -> dict:
    ctx.require(Perm.AI_USE)
    r = db.get(AgentRun, run_id)
    if r is None or r.application_id != ctx.application_id:
        raise NotFound("Run not found")
    steps = list(db.scalars(select(AgentRunStep).where(AgentRunStep.run_id == r.id).order_by(AgentRunStep.position)))
    acts = {a.id: a for a in db.scalars(select(AiPendingAction).where(AiPendingAction.run_id == r.id))}
    return {**run_out(r), "steps": [{
        "id": s.id, "position": s.position, "kind": s.kind, "tool": s.tool,
        "tool_label": tools.REGISTRY[s.tool].label if s.tool in tools.REGISTRY else s.tool, "args": s.args,
        "summary": s.result_summary, "status": s.status, "action_id": s.action_id,
        "action_status": acts[s.action_id].status if s.action_id in acts else None,
        "input_tokens": s.input_tokens, "output_tokens": s.output_tokens, "at": s.created_at.isoformat()}
        for s in steps]}

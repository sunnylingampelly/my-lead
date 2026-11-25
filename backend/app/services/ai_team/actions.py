"""Human in the loop: write tool calls proposed by the assistant or an agent wait here until a person confirms
(assistant) or approves (agent, in the app or from Slack).

* Deciding is a single conditional UPDATE (pending → executing / rejected / cancelled), so double clicks, two
  approvers or a Slack retry can never run an action twice: the loser just gets the action's current state.
* The action runs with the deciding person's own permissions: they must be allowed to do it themselves.
* Every executed action is audit-logged as done "via AI Assistant" or "via AI agent <name>"."""
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.errors import AppError, Forbidden, NotFound
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models.ai_team import AgentRunStep, AiAgent, AiPendingAction, AssistantConversation, AssistantMessage
from app.services import audit_service
from app.services.ai_team import tools
from app.services.ai_team.registry import Prepared, ToolError, validate_args
from app.utils.time import utcnow

log = get_logger(__name__)
EXPIRE_AFTER = timedelta(days=7)
OPEN = "pending"


def propose(db: Session, ctx, tool: str, prepared: Prepared, *, source: str, conversation_id: str | None = None,
            agent: AiAgent | None = None, run_id: str | None = None) -> AiPendingAction:
    a = AiPendingAction(organization_id=ctx.organization_id, application_id=ctx.application_id, source=source,
                        user_id=ctx.user.id if ctx.user else None, conversation_id=conversation_id,
                        agent_id=agent.id if agent else None, run_id=run_id, tool=tool, args=prepared.args,
                        title=prepared.title[:200], fields=prepared.fields, status=OPEN,
                        expires_at=utcnow() + EXPIRE_AFTER)
    db.add(a)
    db.flush()
    return a


def card(a: AiPendingAction, agent_name: str | None = None) -> dict:
    t = tools.REGISTRY.get(a.tool)
    editable = [{"key": k, "label": k.replace("_", " ").capitalize(), "value": a.args.get(k),
                 "multiline": k in ("body", "notes", "summary", "text")}
                for k in (t.editable if t else ()) if k in a.args]
    return {"id": a.id, "tool": a.tool, "label": t.label if t else a.tool, "title": a.title, "fields": a.fields,
            "editable": editable, "status": a.status, "source": a.source, "agent_id": a.agent_id,
            "agent_name": agent_name, "run_id": a.run_id, "conversation_id": a.conversation_id,
            "result": a.result, "error": a.error, "decided_via": a.decided_via,
            "decided_at": a.decided_at.isoformat() if a.decided_at else None, "created_at": a.created_at.isoformat()}


def get(db: Session, ctx, action_id: str) -> AiPendingAction:
    a = db.get(AiPendingAction, action_id)
    if a is None or a.application_id != ctx.application_id:
        raise NotFound("Action not found")
    if a.source == "assistant" and a.user_id != ctx.user.id:
        raise NotFound("Action not found")  # assistant proposals are private to their user
    return a


def _may_decide(ctx, a: AiPendingAction) -> None:
    if a.source == "assistant":
        ctx.require(Perm.AI_USE)
        if a.user_id != ctx.user.id:
            raise Forbidden("Only the person who asked can confirm this", code="NOT_YOURS")
    else:
        ctx.require(Perm.AI_MANAGE)


def _apply_edits(a: AiPendingAction, edits: dict | None) -> dict:
    args = dict(a.args)
    if not edits:
        return args
    t = tools.get(a.tool)
    props = {k: t.parameters["properties"][k] for k in t.editable if k in t.parameters["properties"]}
    clean = validate_args({k: v for k, v in edits.items() if k in props}, {"properties": props})
    for k, v in clean.items():
        if isinstance(v, str) and not v.strip() and k in t.parameters.get("required", []):
            raise ToolError(f"{k.replace('_', ' ').capitalize()} can't be empty", "INVALID_ARGUMENTS")
        args[k] = v
    labels = {k.replace("_", " ").lower(): v for k, v in clean.items()}
    a.fields = [{**f, "value": str(labels[f["label"].lower()])[:300]} if f["label"].lower() in labels else f
                for f in a.fields]
    return args


def decide(db: Session, ctx, action_id: str, approve: bool, *, via: str = "app", edits: dict | None = None,
           action: AiPendingAction | None = None) -> AiPendingAction:
    """Confirm/approve (execute) or cancel/reject a pending action. Safe to call twice."""
    a = action or get(db, ctx, action_id)
    _may_decide(ctx, a)
    if a.status != OPEN:
        return a  # already decided: idempotent
    if a.expires_at and a.expires_at < utcnow():
        db.execute(update(AiPendingAction).where(AiPendingAction.id == a.id, AiPendingAction.status == OPEN)
                   .values(status="expired", updated_at=utcnow()))
        db.commit()
        db.refresh(a)
        return a
    if not approve:
        status = "cancelled" if a.source == "assistant" else "rejected"
        n = db.execute(update(AiPendingAction).where(AiPendingAction.id == a.id, AiPendingAction.status == OPEN)
                       .values(status=status, decided_by_id=ctx.user.id, decided_via=via, decided_at=utcnow(),
                               updated_at=utcnow())).rowcount
        db.commit()
        db.refresh(a)
        if n:
            _after(db, ctx, a)
            db.commit()
        return a
    args = _apply_edits(a, edits)
    n = db.execute(update(AiPendingAction).where(AiPendingAction.id == a.id, AiPendingAction.status == OPEN)
                   .values(status="executing", args=args, fields=a.fields, decided_by_id=ctx.user.id,
                           decided_via=via, decided_at=utcnow(), updated_at=utcnow())).rowcount
    db.commit()
    db.refresh(a)
    if not n:
        return a  # someone else decided first
    try:
        with db.begin_nested():
            out = tools.execute(db, ctx, a.tool, args)
        a.status, a.result, a.error = "executed", out, None
        agent = db.get(AiAgent, a.agent_id) if a.agent_id else None
        via_label = f"AI agent {agent.name}" if agent else "AI Assistant"
        audit_service.record(db, f"ai.{a.tool}", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                             application_id=ctx.application_id, target_type="ai_action", target_id=a.id,
                             summary=f"{a.title} (via {via_label})",
                             meta={"via": via_label, "tool": a.tool, "decided_via": via,
                                   "result": {k: v for k, v in (out.get("data") or {}).items()
                                              if k.endswith("_id")} if isinstance(out.get("data"), dict) else {}})
    except (ToolError, AppError) as exc:
        a.status, a.error = "failed", getattr(exc, "message", str(exc))[:500]
    except Exception as exc:  # noqa: BLE001 - surface as a failed action rather than a 500
        log.exception("ai_action_failed", action_id=a.id)
        a.status, a.error = "failed", f"Something went wrong ({type(exc).__name__})"
    _after(db, ctx, a)
    db.commit()
    return a


def _after(db: Session, ctx, a: AiPendingAction) -> None:
    """Record the outcome where people look: the assistant chat, the agent's run log and the Slack message."""
    who = ctx.user.full_name if ctx.user else "Someone"
    if a.conversation_id and a.source == "assistant":
        conv = db.get(AssistantConversation, a.conversation_id)
        if conv is not None:
            if a.status == "executed":
                text, links = "✅ " + (a.result or {}).get("summary", "Done."), (a.result or {}).get("links") or []
            elif a.status == "failed":
                text, links = f"⚠️ Couldn't do it: {a.error}", []
            else:
                text, links = f"Cancelled: {a.title}.", []
            db.add(AssistantMessage(organization_id=a.organization_id, application_id=a.application_id,
                                    conversation_id=conv.id, role="assistant", content=text, links=links,
                                    tool_calls=[{"action_id": a.id, "status": a.status}]))
            conv.message_count += 1
            conv.updated_at = utcnow()
    if a.run_id:
        step = db.scalar(select(AgentRunStep).where(AgentRunStep.run_id == a.run_id, AgentRunStep.action_id == a.id))
        if step is not None:
            step.status = {"executed": "done", "failed": "failed"}.get(a.status, a.status)
            note = {"executed": f"Approved by {who}" + (" in Slack" if a.decided_via == "slack" else "") + ": " +
                    (a.result or {}).get("summary", ""), "failed": f"Approved by {who}, but it failed: {a.error}",
                    "rejected": f"Rejected by {who}", "expired": "Expired without a decision"}.get(a.status)
            if note:
                step.result_summary = note[:4000]
    if a.slack_channel and a.slack_ts:
        from app.services.ai_team import slack

        try:
            slack.update_decided(db, a, who)
        except Exception:  # noqa: BLE001 - the decision stands even if Slack can't be updated
            log.warning("slack_update_failed", action_id=a.id)


def list_pending(db: Session, ctx, status: str = OPEN, limit: int = 100) -> list[dict]:
    ctx.require(Perm.AI_MANAGE)
    q = select(AiPendingAction).where(AiPendingAction.application_id == ctx.application_id,
                                      AiPendingAction.source == "agent")
    q = q.where(AiPendingAction.status == OPEN) if status == OPEN else q.where(AiPendingAction.status != OPEN)
    rows = list(db.scalars(q.order_by(AiPendingAction.created_at.desc()).limit(limit)))
    names = dict(db.execute(select(AiAgent.id, AiAgent.name).where(
        AiAgent.id.in_({r.agent_id for r in rows if r.agent_id}))).all()) if rows else {}
    return [card(r, names.get(r.agent_id)) for r in rows]


def pending_count(db: Session, ctx) -> int:
    from sqlalchemy import func

    if not ctx.has(Perm.AI_MANAGE):
        return 0
    return db.scalar(select(func.count()).select_from(AiPendingAction).where(
        AiPendingAction.application_id == ctx.application_id, AiPendingAction.source == "agent",
        AiPendingAction.status == OPEN)) or 0


def expire_old(db: Session) -> int:
    now = utcnow()
    return db.execute(update(AiPendingAction).where(AiPendingAction.status == OPEN, AiPendingAction.expires_at < now)
                      .values(status="expired", updated_at=now)).rowcount

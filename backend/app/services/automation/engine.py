"""Workflow execution.

* Triggers are detected by scanning for new list members, tags and contacts since a per-workflow
  cursor (with a small overlap), and segment membership. Enrollment is unique per (workflow,
  contact, trigger key), so overlapping scans and retries never enroll anyone twice. Without
  re-entry a contact goes through a workflow once, ever.
* Runs are claimed (waiting → running) before executing, so two workers never move the same run.
* Each step is recorded. Sends reuse the channel engines (see actions.py); a step whose message is
  waiting for quiet hours or a retry keeps the run on that step until it is due.
* Runs of a paused workflow wait in place; archiving exits them. If a published change removes the
  step a run is on, that run exits with a clear reason.
"""
import secrets
from datetime import timedelta

from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Application, Contact, ContactList, ContactListMember, ContactTag, Segment, Tag
from app.models.automation import Workflow, WorkflowRun, WorkflowStep
from app.services.audience.import_processor import TaskContext
from app.services.audience.query import base_query
from app.services.audience.segments import compile_rules
from app.services.automation import actions
from app.services.automation.graph import CRM_TRIGGERS, ENGAGEMENT_TRIGGERS, Graph, data, label, wait_seconds
from app.services.automation.workflows import CAMPAIGN_MODEL
from app.utils.time import utcnow

log = get_logger(__name__)
OVERLAP = timedelta(seconds=30)
SCAN_LIMIT = 5000
RUN_BATCH = 200
MAX_STEPS_PER_TICK = 50
STALE_RUNNING = timedelta(minutes=10)


def _ctx(db: Session, w: Workflow) -> TaskContext:
    return TaskContext(w.organization_id, w.application_id, db.get(Application, w.application_id), None)


# ------------------------------------------------------------------ triggers


def _candidates(db: Session, w: Workflow, trig: dict, since) -> list[tuple[str, str]]:
    """(contact_id, trigger_key) pairs for contacts who met the trigger since `since`."""
    d, kind = data(trig), data(trig).get("kind")
    once = not w.allow_reentry
    if kind == "contact_created":
        rows = db.execute(select(Contact.id).where(Contact.application_id == w.application_id,
                                                   Contact.created_at >= since).limit(SCAN_LIMIT)).all()
        return [(r[0], "created") for r in rows]
    if kind == "added_to_list":
        rows = db.execute(select(ContactListMember.contact_id, ContactListMember.created_at).where(
            ContactListMember.list_id == d.get("list_id"), ContactListMember.application_id == w.application_id,
            ContactListMember.created_at >= since).limit(SCAN_LIMIT)).all()
        return [(c, "list" if once else f"list:{t.isoformat()}") for c, t in rows]
    if kind == "tag_added":
        rows = db.execute(select(ContactTag.contact_id, ContactTag.created_at).where(
            ContactTag.tag_id == d.get("tag_id"), ContactTag.application_id == w.application_id,
            ContactTag.created_at >= since).limit(SCAN_LIMIT)).all()
        return [(c, "tag" if once else f"tag:{t.isoformat()}") for c, t in rows]
    if kind == "segment_entered":
        seg = db.get(Segment, d.get("segment_id"))
        if seg is None or seg.application_id != w.application_id:
            return []
        stmt = base_query(_ctx(db, w)).where(compile_rules(db, _ctx(db, w), seg.rules)).with_only_columns(
            Contact.id).limit(SCAN_LIMIT)
        return [(r[0], "segment") for r in db.execute(stmt)]
    if kind in ENGAGEMENT_TRIGGERS:
        return _engagement_candidates(db, w.application_id, kind, d, since, once)
    if kind in CRM_TRIGGERS:
        from app.services.crm.automation import candidates

        return candidates(db, w.application_id, d, since, once, SCAN_LIMIT)
    return []


def _engagement_candidates(db: Session, app_id: str, kind: str, d: dict, since, once: bool) -> list[tuple[str, str]]:
    """Replies, clicks, answered calls and opt-outs since `since`. Keys carry the event id when re-entry is on."""
    from app.models import ConsentRecord, EmailEvent, SmsInbound, VoiceCall

    if kind == "sms_replied":
        q = (select(Contact.id, SmsInbound.id, SmsInbound.body, SmsInbound.keyword)
             .join(Contact, (Contact.application_id == SmsInbound.application_id) & (Contact.phone == SmsInbound.from_phone))
             .where(SmsInbound.application_id == app_id, SmsInbound.received_at >= since))
        word = (d.get("keyword") or "").strip().lower()
        out = []
        for cid, eid, body, keyword in db.execute(q.order_by(SmsInbound.received_at).limit(SCAN_LIMIT)):
            if keyword in ("stop", "start", "help"):
                continue  # compliance keywords are handled by the platform, not journeys
            first = (body or "").strip().split()[0].lower() if (body or "").strip() else ""
            if word and first != word:
                continue
            out.append((cid, "sms_reply" if once else f"sms_reply:{eid}"))
        return out
    if kind == "email_clicked":
        q = select(EmailEvent.contact_id, EmailEvent.id).where(
            EmailEvent.application_id == app_id, EmailEvent.type == "clicked", EmailEvent.created_at >= since,
            EmailEvent.contact_id.is_not(None))
        if d.get("campaign_id"):
            q = q.where(EmailEvent.campaign_id == d["campaign_id"])
        rows = db.execute(q.order_by(EmailEvent.created_at).limit(SCAN_LIMIT)).all()
        return [(c, "email_click" if once else f"email_click:{e}") for c, e in rows]
    if kind == "call_answered":
        q = select(VoiceCall.contact_id, VoiceCall.id).where(
            VoiceCall.application_id == app_id, VoiceCall.answered_by == "human", VoiceCall.answered_at >= since,
            VoiceCall.contact_id.is_not(None))
        if d.get("campaign_id"):
            q = q.where(VoiceCall.campaign_id == d["campaign_id"])
        rows = db.execute(q.order_by(VoiceCall.answered_at).limit(SCAN_LIMIT)).all()
        return [(c, "call_answered" if once else f"call_answered:{e}") for c, e in rows]
    if kind == "unsubscribed":
        q = select(ConsentRecord.contact_id, ConsentRecord.id).where(
            ConsentRecord.application_id == app_id, ConsentRecord.status == "revoked",
            ConsentRecord.created_at >= since)
        if d.get("channel") in ("email", "sms", "voice"):
            q = q.where(ConsentRecord.channel == d["channel"])
        rows = db.execute(q.order_by(ConsentRecord.created_at).limit(SCAN_LIMIT)).all()
        return [(c, "unsubscribed" if once else f"unsubscribed:{e}") for c, e in rows]
    return []


def enroll(db: Session, w: Workflow, pairs: list[tuple[str, str]]) -> int:
    g = Graph.load(w.published_graph)
    trig = g.trigger()
    first = g.next(trig["id"]) if trig else None
    if not pairs or first is None:
        return 0
    contact_ids = list({c for c, _ in pairs})
    existing = set(db.execute(select(WorkflowRun.contact_id, WorkflowRun.trigger_key).where(
        WorkflowRun.workflow_id == w.id, WorkflowRun.contact_id.in_(contact_ids))).all())
    active = set(db.scalars(select(WorkflowRun.contact_id).where(
        WorkflowRun.workflow_id == w.id, WorkflowRun.contact_id.in_(contact_ids),
        WorkflowRun.status.in_(("waiting", "running")))))
    now, created = utcnow(), 0
    for contact_id, key in dict.fromkeys(pairs):
        if (contact_id, key) in existing or contact_id in active:
            continue  # already enrolled for this event, or still on the journey
        db.add(WorkflowRun(organization_id=w.organization_id, application_id=w.application_id, workflow_id=w.id,
                           contact_id=contact_id, trigger_key=key[:120], status="waiting", current_node_id=first,
                           wake_at=now, version=w.version, steps_taken=0, started_at=now))
        active.add(contact_id)
        created += 1
    return created


def enroll_manual(db: Session, w: Workflow, contact_ids: list[str]) -> tuple[int, int]:
    """Start the journey now for chosen contacts. Never enrolls someone already on the journey; someone who
    finished it before is enrolled again only when the workflow allows re-entry. Returns (enrolled, skipped)."""
    ids = list(dict.fromkeys(c for c in contact_ids if c))
    if not ids:
        return 0, 0
    valid = set(db.scalars(select(Contact.id).where(Contact.application_id == w.application_id, Contact.id.in_(ids),
                                                    Contact.status != "blocked")))
    previous = set(db.scalars(select(WorkflowRun.contact_id).where(WorkflowRun.workflow_id == w.id,
                                                                   WorkflowRun.contact_id.in_(list(valid)))))
    stamp = utcnow().strftime("%Y%m%d%H%M%S")
    pairs = [(c, f"manual:{stamp}:{secrets.token_hex(4)}") for c in ids
             if c in valid and (w.allow_reentry or c not in previous)]
    enrolled = enroll(db, w, pairs)  # also skips anyone still active in this workflow
    return enrolled, len(ids) - enrolled


def scan_triggers(db: Session) -> int:
    total = 0
    for w in list(db.scalars(select(Workflow).where(Workflow.status == "active"))):
        trig = Graph.load(w.published_graph).trigger()
        if trig is None:
            continue
        now = utcnow()
        start = w.activated_at or now
        # Overlap catches rows committed late, but never reaches back before activation.
        since = max(w.trigger_cursor - OVERLAP, start) if w.trigger_cursor else start
        try:
            n = enroll(db, w, _candidates(db, w, trig, since))
        except Exception:  # noqa: BLE001 - one broken workflow must not stop the others
            log.exception("automation_trigger_scan_failed", workflow_id=w.id)
            db.rollback()
            continue
        w.trigger_cursor = now
        db.commit()
        total += n
    return total


# ------------------------------------------------------------------ execution


def _step(db: Session, run: WorkflowRun, node: dict, outcome: str, detail: str | None = None,
          meta: dict | None = None) -> None:
    db.add(WorkflowStep(organization_id=run.organization_id, application_id=run.application_id,
                        workflow_id=run.workflow_id, run_id=run.id, node_id=node["id"], node_type=node["type"],
                        outcome=outcome, detail=(detail or "")[:1000] or None, meta=meta or None))


def _finish(run: WorkflowRun, status: str, reason: str | None = None) -> None:
    run.status, run.exit_reason, run.finished_at, run.wake_at = status, reason, utcnow(), None
    run.current_node_id = None if status == "completed" else run.current_node_id


def _condition(db: Session, w: Workflow, g: Graph, node: dict, contact: Contact) -> bool:
    d = data(node)
    if (d.get("kind") or "rules") == "engagement":
        src = g.nodes.get(d.get("node_id") or "")
        cid = (w.node_campaigns or {}).get(d.get("node_id") or "")
        return bool(src and cid and actions.engaged(db, src["type"], cid, contact.id, d.get("event")))
    ctx = _ctx(db, w)
    return (db.scalar(select(func.count()).select_from(
        base_query(ctx).where(Contact.id == contact.id, compile_rules(db, ctx, d.get("rules") or {})).subquery())) or 0) > 0


def _update_contact(db: Session, w: Workflow, node: dict, contact: Contact) -> str:
    d, ctx = data(node), _ctx(db, w)
    from app.services.audience.contacts import add_tags, add_to_lists

    action = d.get("action")
    if action == "add_tag" and db.get(Tag, d.get("tag_id")):
        return "Tag added" if add_tags(db, ctx, [contact.id], [d["tag_id"]]) else "Already tagged"
    if action == "remove_tag":
        n = db.execute(delete(ContactTag).where(ContactTag.contact_id == contact.id,
                                                ContactTag.tag_id == d.get("tag_id"))).rowcount
        return "Tag removed" if n else "Did not have the tag"
    if action == "add_to_list" and db.get(ContactList, d.get("list_id")):
        return "Added to list" if add_to_lists(db, ctx, [contact.id], [d["list_id"]]) else "Already in the list"
    if action == "remove_from_list":
        n = db.execute(delete(ContactListMember).where(ContactListMember.contact_id == contact.id,
                                                       ContactListMember.list_id == d.get("list_id"))).rowcount
        return "Removed from list" if n else "Was not in the list"
    return "Nothing to change"


def _send(db: Session, w: Workflow, node: dict, contact: Contact) -> actions.SendResult:
    cid = (w.node_campaigns or {}).get(node["id"])
    campaign = db.get(CAMPAIGN_MODEL[node["type"]], cid) if cid else None
    if campaign is None:
        return actions.SendResult("failed", "This step's content is missing; publish the workflow again")
    from app.services.billing import wallet as wl

    if not wl.can_spend(db, w.organization_id):
        # Hold the person on this step until credit is added, rather than skipping the message.
        return actions.SendResult("waiting", "Waiting for wallet credit", utcnow() + timedelta(hours=1))
    fn = {"send_email": actions.send_email, "send_sms": actions.send_sms, "voice_call": actions.voice_call}[node["type"]]
    return fn(db, campaign, contact)


def advance(db: Session, w: Workflow, run: WorkflowRun) -> None:
    """Move one run forward until it waits, finishes or hits the per-tick step limit."""
    g = Graph.load(w.published_graph)
    contact = db.get(Contact, run.contact_id) if run.contact_id else None
    for _ in range(MAX_STEPS_PER_TICK):
        if contact is None:
            return _finish(run, "exited", "Contact was deleted")
        if contact.status == "blocked":
            return _finish(run, "exited", "Contact is blocked")
        node = g.nodes.get(run.current_node_id or "")
        if node is None:
            return _finish(run, "completed") if run.current_node_id is None else _finish(
                run, "exited", "This step was removed in a newer version of the workflow")
        run.steps_taken += 1
        t, nxt = node["type"], None
        if t == "end":
            _step(db, run, node, "done", "Reached the end")
            return _finish(run, "completed")
        if t == "wait":
            secs = wait_seconds(node)
            run.current_node_id, run.wake_at, run.status = g.next(node["id"]), utcnow() + timedelta(seconds=secs), "waiting"
            _step(db, run, node, "waiting", f"Until {run.wake_at.isoformat(timespec='minutes')}")
            if run.current_node_id is None:
                _step(db, run, node, "done", "Last step")
            return None
        if t in ("send_email", "send_sms", "voice_call"):
            res = _send(db, w, node, contact)
            if res.outcome == "waiting":
                run.wake_at, run.status = res.retry_at, "waiting"
                _step(db, run, node, "waiting", res.detail)
                return None
            _step(db, run, node, res.outcome, res.detail)
            nxt = g.next(node["id"])
        elif t == "condition":
            yes = _condition(db, w, g, node, contact)
            _step(db, run, node, "branch_yes" if yes else "branch_no", "Condition met" if yes else "Condition not met")
            nxt = g.next(node["id"], "yes" if yes else "no")
        elif t == "split":
            a = secrets.randbelow(10000) < int(data(node).get("percent_a", 50)) * 100
            _step(db, run, node, "branch_a" if a else "branch_b", "Path A" if a else "Path B")
            nxt = g.next(node["id"], "a" if a else "b")
        elif t == "update_contact":
            _step(db, run, node, "done", _update_contact(db, w, node, contact))
            nxt = g.next(node["id"])
        elif t == "crm_action":
            from app.services.crm.automation import run_action

            meta: dict = {}
            detail = run_action(db, w.organization_id, w.application_id, data(node), contact, meta)
            _step(db, run, node, "done", detail, meta)
            nxt = g.next(node["id"])
        elif t == "ai_step":
            from app.services.ai_team.workflow_nodes import run_ai_step

            outcome, detail = run_ai_step(db, w.organization_id, w.application_id, data(node), contact)
            _step(db, run, node, outcome, detail)
            nxt = g.next(node["id"])
        elif t == "slack_message":
            from app.services.ai_team.workflow_nodes import run_slack

            outcome, detail = run_slack(db, w.organization_id, data(node), contact)
            _step(db, run, node, outcome, detail)
            nxt = g.next(node["id"])
        else:
            _step(db, run, node, "skipped", f"Unsupported step {t}")
            nxt = g.next(node["id"])
        run.current_node_id = nxt
        if nxt is None:
            return _finish(run, "completed")
    run.status, run.wake_at = "waiting", utcnow()  # continue on the next tick
    return None


# ------------------------------------------------------------------ dry run


def _amount(node: dict) -> str:
    d = data(node)
    n, unit = d.get("amount") or 0, d.get("unit") or "hours"
    return f"{n} {unit[:-1] if str(n) == '1' else unit}"


def _send_preview(db: Session, node: dict, contact: Contact) -> tuple[str, str]:
    from app.models.email import EmailTemplate
    from app.models.voice import VoiceAudio

    d, t = data(node), node["type"]
    if t == "send_email":
        tpl = db.get(EmailTemplate, d.get("template_id")) if d.get("template_id") else None
        what = f"email “{(d.get('subject') or '').strip() or (tpl.name if tpl else 'no template chosen')}”"
        if not contact.email:
            return "would_skip", f"Would skip the {what}: no email address"
        if contact.email_unsubscribed_at:
            return "would_skip", f"Would skip the {what}: unsubscribed from email"
        return "would_send", f"Would send {what} to {contact.email}"
    if t == "send_sms":
        body = (d.get("body") or "").strip()
        what = f"SMS “{body[:60]}{'…' if len(body) > 60 else ''}”" if body else "SMS (no message yet)"
        if not contact.phone:
            return "would_skip", f"Would skip the {what}: no phone number"
        if contact.sms_unsubscribed_at:
            return "would_skip", f"Would skip the {what}: opted out of SMS"
        return "would_send", f"Would send {what} to {contact.phone}"
    audio = db.get(VoiceAudio, d.get("audio_id")) if d.get("audio_id") else None
    what = f"call with “{audio.name}”" if audio else "call (no message chosen)"
    if not contact.phone:
        return "would_skip", f"Would skip the {what}: no phone number"
    if contact.voice_unsubscribed_at:
        return "would_skip", f"Would skip the {what}: opted out of calls"
    return "would_send", f"Would place a {what} to {contact.phone}"


def _update_preview(db: Session, node: dict) -> str:
    d = data(node)
    action = d.get("action")
    if action in ("add_tag", "remove_tag"):
        tag = db.get(Tag, d.get("tag_id")) if d.get("tag_id") else None
        return f"Would {'add' if action == 'add_tag' else 'remove'} tag “{tag.name if tag else '?'}”"
    if action in ("add_to_list", "remove_from_list"):
        lst = db.get(ContactList, d.get("list_id")) if d.get("list_id") else None
        return f"Would {'add to' if action == 'add_to_list' else 'remove from'} list “{lst.name if lst else '?'}”"
    return "Nothing to change"


def dry_run(db: Session, w: Workflow, graph: dict, contact: Contact) -> list[dict]:
    """Walk `graph` for one contact without sending, enrolling or changing anything. Conditions are evaluated
    against the contact's current data; engagement checks use what really happened, so in a test they
    usually follow No (the earlier message was not actually sent)."""
    from app.core.errors import ValidationFailed
    from app.services.automation.graph import TRIGGER_NAMES
    from app.services.crm.automation import preview_action

    g = Graph.load(graph)
    trig = g.trigger()
    if trig is None:
        return [{"node_id": None, "label": "Trigger", "outcome": "problem", "detail": "The workflow needs a trigger"}]
    out = [{"node_id": trig["id"], "label": "Trigger", "outcome": "trigger",
            "detail": f"{TRIGGER_NAMES.get(data(trig).get('kind'), 'Trigger')}: skipped for this test, the contact starts "
                      "at the first step"}]
    nid, seen = g.next(trig["id"]), {trig["id"]}
    while nid and nid not in seen and len(out) <= MAX_STEPS_PER_TICK:
        seen.add(nid)
        node = g.nodes[nid]
        t, nxt = node["type"], g.next(nid)
        step = {"node_id": nid, "label": label(node)}
        if t == "end":
            step.update(outcome="end", detail="The journey ends")
        elif t == "wait":
            step.update(outcome="wait", detail=f"Would wait {_amount(node)}")
        elif t in ("send_email", "send_sms", "voice_call"):
            outcome, detail = _send_preview(db, node, contact)
            step.update(outcome=outcome, detail=detail)
        elif t == "condition":
            d = data(node)
            try:
                yes = _condition(db, w, g, node, contact)
                if (d.get("kind") or "rules") == "engagement":
                    src = g.nodes.get(d.get("node_id") or "")
                    why = (f"“{label(src) if src else 'the earlier step'}” was {d.get('event')}" if yes else
                           f"“{label(src) if src else 'the earlier step'}” was not {d.get('event')} "
                           "(nothing is sent in a test)")
                else:
                    why = "the contact matches the rules" if yes else "the contact doesn't match the rules"
                step.update(outcome="branch_yes" if yes else "branch_no",
                            detail=f"Condition → {'Yes' if yes else 'No'} because {why}")
                nxt = g.next(nid, "yes" if yes else "no")
            except (ValidationFailed, KeyError, TypeError):
                step.update(outcome="problem", detail="This condition isn't set up yet")
                nxt = None
        elif t == "split":
            pct = int(data(node).get("percent_a", 50) or 50)
            step.update(outcome="branch_a", detail=f"Split: {pct}% go to A at random; this test follows path A")
            nxt = g.next(nid, "a")
        elif t == "update_contact":
            step.update(outcome="would_do", detail=_update_preview(db, node))
        elif t == "crm_action":
            step.update(outcome="would_do",
                        detail=preview_action(db, w.organization_id, w.application_id, data(node), contact))
        elif t in ("ai_step", "slack_message"):
            from app.services.ai_team import workflow_nodes

            step.update(outcome="would_do", detail=workflow_nodes.preview_ai_step(data(node)) if t == "ai_step"
                        else workflow_nodes.preview_slack(data(node), contact))
        else:
            step.update(outcome="skipped", detail=f"Unsupported step {t}")
        out.append(step)
        nid = nxt
    if nid and nid in seen:
        out.append({"node_id": nid, "label": label(g.nodes[nid]), "outcome": "problem",
                    "detail": "The workflow loops back on itself here"})
    return out


def process_runs(limit: int = RUN_BATCH) -> int:
    now = utcnow()
    done = 0
    with SessionLocal() as db:
        db.execute(update(WorkflowRun).where(WorkflowRun.status == "running",
                                             WorkflowRun.updated_at < now - STALE_RUNNING)
                   .values(status="waiting", wake_at=now))
        db.commit()
        ids = list(db.scalars(select(WorkflowRun.id).join(Workflow, Workflow.id == WorkflowRun.workflow_id).where(
            WorkflowRun.status == "waiting", WorkflowRun.wake_at <= now, Workflow.status == "active")
            .order_by(WorkflowRun.wake_at).limit(limit)))
        for rid in ids:
            claimed = db.execute(update(WorkflowRun).where(WorkflowRun.id == rid, WorkflowRun.status == "waiting")
                                 .values(status="running", updated_at=utcnow())).rowcount
            db.commit()
            if not claimed:
                continue
            run = db.get(WorkflowRun, rid)
            w = db.get(Workflow, run.workflow_id)
            try:
                advance(db, w, run)
                if run.status == "running":
                    run.status = "waiting"
                db.commit()
                done += 1
            except Exception as exc:  # noqa: BLE001 - one bad run must not block the queue
                db.rollback()
                log.exception("automation_run_failed", run_id=rid)
                run = db.get(WorkflowRun, rid)
                run.status, run.exit_reason, run.finished_at = "failed", type(exc).__name__, utcnow()
                db.commit()
    return done


def tick() -> dict:
    with SessionLocal() as db:
        enrolled = scan_triggers(db)
    return {"enrolled": enrolled, "advanced": process_runs()}

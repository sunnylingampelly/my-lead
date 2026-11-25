"""CRM in the automation builder.

Triggers read the CRM event log (deal created / moved / won / lost / going cold, hot score reached,
first-response SLA missed, owner assigned). The `crm_action` step creates deals and tasks, assigns
owners, moves deals and sets lifecycle stages. Everything runs as the platform (no user)."""
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AssignmentRule, Contact, CrmEvent, CrmSettings, Deal, Pipeline, PipelineStage, ScoringRule, User
from app.schemas.crm import LIFECYCLE_VALUES, DealCreate, TaskCreate
from app.services.crm.common import record_event, system_activity, system_ctx, team
from app.utils.time import utcnow

CRM_ACTIONS = ("create_deal", "create_task", "assign_owner", "move_deal", "set_lifecycle")
ACTION_NAMES = {"create_deal": "Create deal", "create_task": "Create task", "assign_owner": "Assign owner",
                "move_deal": "Move deal", "set_lifecycle": "Set lifecycle stage"}
TASK_TYPES = ("call", "email", "meeting", "follow_up", "todo")


def candidates(db: Session, application_id: str, trig: dict, since, once: bool, limit: int) -> list[tuple[str, str]]:
    kind = trig.get("kind")
    q = select(CrmEvent).where(CrmEvent.application_id == application_id, CrmEvent.kind == kind,
                               CrmEvent.created_at >= since, CrmEvent.contact_id.is_not(None))
    out = []
    for e in db.scalars(q.order_by(CrmEvent.created_at).limit(limit)):
        d = e.data or {}
        if trig.get("pipeline_id") and d.get("pipeline_id") != trig["pipeline_id"]:
            continue
        if trig.get("stage_id") and d.get("stage_id") != trig["stage_id"]:
            continue
        if trig.get("interest") and d.get("interest") != trig["interest"]:  # ai_call_completed
            continue
        if trig.get("bot_id") and d.get("bot_id") != trig["bot_id"]:  # chat_lead_captured / _conversation_closed
            continue
        if trig.get("lead_quality") and d.get("lead_quality") != trig["lead_quality"]:  # chat_conversation_closed
            continue
        if trig.get("form_id") and d.get("form_id") != trig["form_id"]:  # form_submitted
            continue
        out.append((e.contact_id, kind if once else f"{kind}:{e.id}"))
    return out


def _settings(db: Session, application_id: str) -> CrmSettings | None:
    return db.get(CrmSettings, application_id)


def trigger_issue(db: Session, application_id: str, d: dict) -> str | None:
    if d.get("pipeline_id"):
        p = db.get(Pipeline, d["pipeline_id"])
        if p is None or p.application_id != application_id:
            return "Choose a pipeline"
    if d.get("stage_id"):
        st = db.get(PipelineStage, d["stage_id"])
        if st is None or st.application_id != application_id or (d.get("pipeline_id") and
                                                                 st.pipeline_id != d["pipeline_id"]):
            return "Choose a stage in that pipeline"
    if d.get("kind") == "ai_call_completed" and d.get("interest") and d["interest"] not in (
            "hot", "warm", "cold", "not_interested"):
        return "Choose an interest level, or any"
    if d.get("kind") == "form_submitted" and d.get("form_id"):
        from app.models.forms import LeadForm

        f = db.get(LeadForm, d["form_id"])
        if f is None or f.application_id != application_id:
            return "Choose a form, or any form"
    if d.get("kind") in ("chat_lead_captured", "chat_conversation_closed") and d.get("bot_id"):
        from app.models.chat import ChatBot

        b = db.get(ChatBot, d["bot_id"])
        if b is None or b.application_id != application_id:
            return "Choose a chatbot, or any"
    if d.get("kind") == "chat_conversation_closed" and d.get("lead_quality") and d["lead_quality"] not in (
            "hot", "warm", "cold"):
        return "Choose a lead quality, or any"
    if d.get("kind") == "sla_breached":
        s = _settings(db, application_id)
        if s is None or not s.sla_enabled:
            return "Turn on the first-response SLA in CRM settings"
    return None


def trigger_warning(db: Session, application_id: str, d: dict) -> str | None:
    """Non-blocking advice: the trigger is valid but may never fire as things stand."""
    if d.get("kind") == "score_reached":
        has_rules = db.scalar(select(ScoringRule.id).where(ScoringRule.application_id == application_id,
                                                           ScoringRule.active.is_(True)).limit(1))
        if not has_rules:
            return "No lead scoring rules yet, so no one can become hot. Add scoring rules in CRM settings."
    return None


def _fallback_issue(db: Session, application_id: str, organization_id: str, d: dict) -> str | None:
    if d.get("fallback_rule_id"):
        r = db.get(AssignmentRule, d["fallback_rule_id"])
        if r is None or r.application_id != application_id:
            return "Choose an assignment rule for contacts without an owner"
    elif d.get("fallback_user_id") and d["fallback_user_id"] not in team(db, organization_id, application_id):
        return "Choose who gets the task when the contact has no owner"
    return None


def action_issue(db: Session, application_id: str, organization_id: str, d: dict) -> str | None:
    action = d.get("action")
    if action not in CRM_ACTIONS:
        return "Choose a CRM action"
    if action == "create_deal":
        if d.get("pipeline_id") and trigger_issue(db, application_id, {"pipeline_id": d["pipeline_id"],
                                                                       "stage_id": d.get("stage_id")}):
            return "Choose a pipeline and stage"
        try:
            if float(d.get("amount") or 0) < 0:
                return "Amount can't be negative"
        except (TypeError, ValueError):
            return "Enter a number for the amount"
    elif action == "create_task":
        if not str(d.get("title") or "").strip():
            return "Enter a task title"
        if (d.get("task_type") or "follow_up") not in TASK_TYPES:
            return "Choose a task type"
        try:
            if not 0 <= int(d.get("due_in_hours") or 0) <= 24 * 90:
                return "Due within 90 days"
        except (TypeError, ValueError):
            return "Enter hours as a number"
        return _fallback_issue(db, application_id, organization_id, d)
    elif action == "assign_owner":
        if d.get("rule_id"):
            r = db.get(AssignmentRule, d["rule_id"])
            if r is None or r.application_id != application_id:
                return "Choose an assignment rule"
        elif d.get("user_id") not in team(db, organization_id, application_id):
            return "Choose who should own the contact"
    elif action == "move_deal":
        st = db.get(PipelineStage, d.get("stage_id") or "")
        if st is None or st.application_id != application_id:
            return "Choose a stage"
        if st.kind == "lost":
            return "Use an open or Won stage (Lost needs a reason)"
    elif action == "set_lifecycle" and d.get("lifecycle_stage") not in LIFECYCLE_VALUES:
        return "Choose a lifecycle stage"
    return None


def action_warning(d: dict) -> str | None:
    if d.get("action") == "create_task" and not (d.get("fallback_user_id") or d.get("fallback_rule_id")):
        return "Contacts without an owner get an unassigned task. Choose a fallback assignee."
    return None


def _pick_fallback(db: Session, organization_id: str, application_id: str, d: dict) -> str | None:
    from app.services.crm import leads

    members = set(team(db, organization_id, application_id))
    if d.get("fallback_rule_id"):
        rule = db.get(AssignmentRule, d["fallback_rule_id"])
        return leads._pick(db, rule, members) if rule else None
    uid = d.get("fallback_user_id")
    return uid if uid in members else None


def _name(contact: Contact) -> str:
    return contact.full_name or contact.email or contact.phone or "contact"


def _user_name(db: Session, uid: str | None) -> str:
    u = db.get(User, uid) if uid else None
    return u.full_name if u else "a teammate"


def describe(db: Session, d: dict) -> str:
    """Short display summary of a crm_action step, e.g. "Create task: Follow up with {{name}}"."""
    action = d.get("action")
    name = ACTION_NAMES.get(action, "CRM action")
    if action in ("create_task", "create_deal") and d.get("title"):
        return f"{name}: {d['title']}"[:200]
    if action == "move_deal":
        st = db.get(PipelineStage, d.get("stage_id") or "")
        return f"{name}: {st.name}" if st else name
    if action == "set_lifecycle" and d.get("lifecycle_stage"):
        return f"{name}: {d['lifecycle_stage']}"
    if action == "assign_owner" and d.get("user_id"):
        return f"{name}: {_user_name(db, d['user_id'])}"
    return name


def preview_action(db: Session, organization_id: str, application_id: str, d: dict, contact: Contact) -> str:
    """What the step would do for this contact, without changing anything (dry runs)."""
    action = d.get("action")
    name = _name(contact)
    if action == "create_deal":
        title = (str(d.get("title") or "").strip() or f"{name} deal").replace("{{name}}", name)
        if db.scalar(select(Deal.id).where(Deal.contact_id == contact.id, Deal.status == "open",
                                           *([Deal.pipeline_id == d["pipeline_id"]] if d.get("pipeline_id") else []))
                     .limit(1)) and not d.get("allow_multiple"):
            return f"Would skip creating “{title}”: already has an open deal"
        return f"Would create deal “{title}”"
    if action == "create_task":
        title = str(d.get("title") or "").replace("{{name}}", name)
        if contact.owner_id:
            who = f"{_user_name(db, contact.owner_id)} (the owner)"
        elif d.get("fallback_rule_id"):
            who = "the next person in the fallback assignment rule"
        elif d.get("fallback_user_id"):
            who = f"{_user_name(db, d['fallback_user_id'])} (fallback, no owner)"
        else:
            who = "nobody (no owner and no fallback)"
        return f"Would create task “{title}” for {who}"
    if action == "assign_owner":
        if d.get("rule_id"):
            return "Would assign an owner using the assignment rule's rotation"
        return f"Would assign {_user_name(db, d.get('user_id'))} as owner"
    if action == "move_deal":
        st = db.get(PipelineStage, d.get("stage_id") or "")
        return f"Would move their open deal to {st.name}" if st else "Would move their deal"
    if action == "set_lifecycle":
        return f"Would set lifecycle stage to {d.get('lifecycle_stage')}"
    return "Nothing to do"


def run_action(db: Session, organization_id: str, application_id: str, d: dict, contact: Contact,
               meta: dict | None = None) -> str:
    """Execute one crm_action step for a contact. Returns a short description for the run history and
    records what it created (task_id / deal_id) in `meta` when given."""
    from app.services.crm import deals, leads, work

    meta = meta if meta is not None else {}
    ctx = system_ctx(db, organization_id, application_id)
    action = d.get("action")
    name = _name(contact)
    if action == "create_deal":
        existing = db.scalar(select(Deal.id).where(
            Deal.contact_id == contact.id, Deal.status == "open",
            *([Deal.pipeline_id == d["pipeline_id"]] if d.get("pipeline_id") else [])).limit(1))
        if existing and not d.get("allow_multiple"):
            meta["deal_id"] = existing
            return "Already has an open deal"
        title = (str(d.get("title") or "").strip() or f"{name} deal").replace("{{name}}", name)[:200]
        deal = deals.create_deal(db, ctx, DealCreate(
            title=title, pipeline_id=d.get("pipeline_id") or None, stage_id=d.get("stage_id") or None,
            amount=d.get("amount") or None, contact_id=contact.id, source="automation"))
        meta["deal_id"] = deal.id
        return f"Created deal {deal.title}"
    if action == "create_task":
        hours = int(d.get("due_in_hours") or 24)
        fallback = None if contact.owner_id else _pick_fallback(db, organization_id, application_id, d)
        t = work.create_task(db, ctx, TaskCreate(
            title=str(d.get("title")).replace("{{name}}", name)[:200], type=d.get("task_type") or "follow_up",
            priority=d.get("priority") if d.get("priority") in ("low", "normal", "high") else "normal",
            due_at=utcnow() + timedelta(hours=hours), contact_id=contact.id, assignee_id=fallback))
        meta["task_id"] = t.id
        if not t.assignee_id:
            return f"Task “{t.title}” created, unassigned (no owner and no fallback)"
        who = _user_name(db, t.assignee_id)
        return f"Task “{t.title}” created for {who}{' (fallback)' if fallback else ''}"
    if action == "assign_owner":
        members = set(team(db, organization_id, application_id))
        if d.get("rule_id"):
            rule = db.get(AssignmentRule, d["rule_id"])
            uid = leads._pick(db, rule, members) if rule else None
        else:
            uid = d.get("user_id") if d.get("user_id") in members else None
        if not uid:
            return "Nobody available to assign"
        if contact.owner_id == uid:
            return "Already owned by that person"
        contact.owner_id = uid
        leads._assigned(db, contact)
        return f"Assigned to {_user_name(db, uid)}"
    if action == "move_deal":
        st = db.get(PipelineStage, d.get("stage_id") or "")
        deal = db.scalar(select(Deal).where(Deal.contact_id == contact.id, Deal.pipeline_id == st.pipeline_id,
                                            Deal.status == "open").order_by(Deal.created_at.desc()).limit(1)) \
            if st else None
        if deal is None:
            return "No open deal in that pipeline"
        meta["deal_id"] = deal.id
        if deal.stage_id == st.id:
            return "Deal already in that stage"
        deals.move_deal(db, ctx, deal.id, st.id)
        return f"Moved {deal.title} to {st.name}"
    if action == "set_lifecycle":
        stage = d.get("lifecycle_stage")
        if contact.lifecycle_stage == stage:
            return "Lifecycle stage unchanged"
        system_activity(db, organization_id, application_id, f"Lifecycle stage: {contact.lifecycle_stage} → {stage}",
                        contact_id=contact.id, meta={"by": "automation"})
        contact.lifecycle_stage = stage
        record_event(db, organization_id, application_id, "lifecycle_changed", contact_id=contact.id,
                     data={"lifecycle_stage": stage})
        return f"Lifecycle stage set to {stage}"
    return "Nothing to do"

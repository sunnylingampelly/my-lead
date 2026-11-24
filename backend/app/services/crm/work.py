"""Tasks, notes (with @mentions), logged activities, and the unified timeline that merges CRM work
with the email, SMS and voice history the platform already records."""
import re
from datetime import datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Forbidden, ValidationFailed
from app.core.permissions import Perm
from app.models import (
    Company,
    Contact,
    ContactActivity,
    CrmActivity,
    CrmNote,
    CrmTask,
    Deal,
    EmailCampaign,
    EmailEvent,
    EmailMessage,
    SmsCampaign,
    SmsInbound,
    SmsMessage,
    VoiceCall,
    VoiceCampaign,
)
from app.schemas.common import Page, PageParams
from app.schemas.crm import ActivityCreate, NoteCreate, NoteUpdate, TaskCreate, TaskUpdate
from app.services.crm.common import (
    audit,
    check_owner,
    contact_ref,
    get_in_app,
    optional_in_app,
    team,
    touched,
    user_ref,
    users_by_id,
)
from app.services.notification_service import notify
from app.utils.time import utcnow

MENTION_RE = re.compile(r"@\[([^\]]{1,150})\]\(([0-9a-f-]{36})\)")  # @[Full Name](user-id)


def _targets(db: Session, ctx, contact_id, deal_id, company_id, required: bool = True):
    contact = optional_in_app(db, ctx, Contact, contact_id, "Contact")
    deal = optional_in_app(db, ctx, Deal, deal_id, "Deal")
    company = optional_in_app(db, ctx, Company, company_id, "Company")
    if required and not (contact or deal or company):
        raise ValidationFailed("Link this to a contact, deal or company", code="TARGET_REQUIRED")
    if deal is not None and contact is None and deal.contact_id:
        contact = db.get(Contact, deal.contact_id)
    return contact, deal, company


def _link(kind: str, obj_id: str) -> str:
    return f"/audience/contacts/{obj_id}" if kind == "contacts" else f"/crm/{kind}/{obj_id}"


# ------------------------------------------------------------------ tasks

def tasks_out(db: Session, tasks: list[CrmTask]) -> list[dict]:
    users = users_by_id(db, [t.assignee_id for t in tasks])
    contacts = {c.id: c for c in db.scalars(select(Contact).where(
        Contact.id.in_({t.contact_id for t in tasks if t.contact_id})))} if tasks else {}
    deals = {d.id: d for d in db.scalars(select(Deal).where(Deal.id.in_({t.deal_id for t in tasks if t.deal_id})))} \
        if tasks else {}
    companies = {c.id: c for c in db.scalars(select(Company).where(
        Company.id.in_({t.company_id for t in tasks if t.company_id})))} if tasks else {}
    now = utcnow()
    return [{"id": t.id, "title": t.title, "type": t.type, "priority": t.priority, "status": t.status,
             "due_at": t.due_at, "overdue": t.status == "open" and t.due_at is not None and t.due_at < now,
             "notes": t.notes, "assignee": user_ref(users.get(t.assignee_id)),
             "contact": contact_ref(contacts.get(t.contact_id)),
             "deal": {"id": t.deal_id, "name": deals[t.deal_id].title} if t.deal_id in deals else None,
             "company": {"id": t.company_id, "name": companies[t.company_id].name} if t.company_id in companies
             else None, "completed_at": t.completed_at, "created_at": t.created_at} for t in tasks]


def _end_of_local_day(ctx):
    """End of today in the application's time zone, as a UTC instant. "Today" = from now until then;
    anything due before now is overdue. The task list and the summary both use this."""
    from zoneinfo import ZoneInfo

    try:
        tz = ZoneInfo(getattr(ctx.application, "timezone", None) or "UTC")
    except Exception:  # noqa: BLE001 - unknown zone names fall back to UTC
        tz = ZoneInfo("UTC")
    local = utcnow().astimezone(tz)
    end = local.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return end.astimezone(utcnow().tzinfo)


def list_tasks(db: Session, ctx, params: PageParams, *, assignee_id: str | None = None, status: str | None = "open",
               due: str | None = None, contact_id: str | None = None, deal_id: str | None = None,
               company_id: str | None = None) -> Page:
    ctx.require(Perm.CRM_READ)
    q = select(CrmTask).where(CrmTask.application_id == ctx.application_id)
    if assignee_id:
        q = q.where(CrmTask.assignee_id == (ctx.user.id if assignee_id == "me" else assignee_id))
    if status:
        q = q.where(CrmTask.status == status)
    now, end_of_today = utcnow(), _end_of_local_day(ctx)
    if due == "overdue":
        q = q.where(CrmTask.due_at < now)
    elif due == "today":
        q = q.where(CrmTask.due_at >= now, CrmTask.due_at < end_of_today)
    elif due == "upcoming":
        q = q.where(CrmTask.due_at >= end_of_today)
    elif due == "none":
        q = q.where(CrmTask.due_at.is_(None))
    for col, val in ((CrmTask.contact_id, contact_id), (CrmTask.deal_id, deal_id), (CrmTask.company_id, company_id)):
        if val:
            q = q.where(col == val)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    # Overdue first, then by due date (no due date last), then newest.
    items = list(db.scalars(q.order_by(CrmTask.status, CrmTask.due_at.is_(None), CrmTask.due_at,
                                       CrmTask.created_at.desc()).offset(params.offset).limit(params.page_size)))
    return Page(items=tasks_out(db, items), total=total, page=params.page, page_size=params.page_size)


def task_counts(db: Session, ctx, user_id: str) -> dict:
    ctx.require(Perm.CRM_READ)
    now = utcnow()
    base = select(func.count()).select_from(CrmTask).where(
        CrmTask.application_id == ctx.application_id, CrmTask.assignee_id == user_id, CrmTask.status == "open")
    end = _end_of_local_day(ctx)
    return {"open": db.scalar(base) or 0, "overdue": db.scalar(base.where(CrmTask.due_at < now)) or 0,
            "today": db.scalar(base.where(CrmTask.due_at >= now, CrmTask.due_at < end)) or 0}


def create_task(db: Session, ctx, data: TaskCreate, *, created_by: str | None = None) -> CrmTask:
    ctx.require(Perm.CRM_WRITE)
    contact, deal, company = _targets(db, ctx, data.contact_id, data.deal_id, data.company_id, required=False)
    assignee = check_owner(db, ctx, data.assignee_id) if data.assignee_id else (
        (deal.owner_id if deal else None) or (contact.owner_id if contact else None) or
        (ctx.user.id if ctx.user else None))
    t = CrmTask(organization_id=ctx.organization_id, application_id=ctx.application_id, title=data.title.strip(),
                type=data.type, priority=data.priority, due_at=data.due_at, notes=data.notes, assignee_id=assignee,
                contact_id=contact.id if contact else None, deal_id=deal.id if deal else None,
                company_id=company.id if company else None, status="open",
                created_by_id=created_by or (ctx.user.id if ctx.user else None))
    db.add(t)
    db.flush()
    actor = ctx.user.id if ctx.user else None
    if assignee and assignee != actor:
        notify(db, assignee, type_="crm_task_assigned", title=f"New task: {t.title}"[:160],
               body=f"Due {t.due_at:%d %b %Y %H:%M} UTC" if t.due_at else None,
               link=f"/apps/{ctx.application_id}/crm/tasks?task={t.id}", organization_id=ctx.organization_id,
               application_id=ctx.application_id)
    return t


def update_task(db: Session, ctx, task_id: str, data: TaskUpdate) -> CrmTask:
    ctx.require(Perm.CRM_WRITE)
    t = get_in_app(db, ctx, CrmTask, task_id, "Task")
    values = data.model_dump(exclude_unset=True)
    if "assignee_id" in values:
        check_owner(db, ctx, values["assignee_id"])
    if "due_at" in values:
        t.reminded_at = None
    status = values.pop("status", None)
    for k, v in values.items():
        setattr(t, k, v)
    if status and status != t.status:
        t.status = status
        t.completed_at = utcnow() if status == "done" else None
        if status == "done":
            contact = db.get(Contact, t.contact_id) if t.contact_id else None
            deal = db.get(Deal, t.deal_id) if t.deal_id else None
            touched(db, contact=contact, deal=deal)
            db.add(CrmActivity(organization_id=ctx.organization_id, application_id=ctx.application_id, type="system",
                               subject=f"Task completed: {t.title}"[:200], actor_user_id=ctx.user.id,
                               contact_id=t.contact_id, deal_id=t.deal_id, company_id=t.company_id,
                               meta={"task_id": t.id, "task_type": t.type}))
    return t


def get_task(db: Session, ctx, task_id: str) -> CrmTask:
    ctx.require(Perm.CRM_READ)
    return get_in_app(db, ctx, CrmTask, task_id, "Task")


def delete_task(db: Session, ctx, task_id: str) -> None:
    ctx.require(Perm.CRM_WRITE)
    db.delete(get_in_app(db, ctx, CrmTask, task_id, "Task"))


# ------------------------------------------------------------------ notes

def notes_out(db: Session, notes: list[CrmNote]) -> list[dict]:
    users = users_by_id(db, [n.author_id for n in notes] + [m for n in notes for m in (n.mentions or [])])
    return [{"id": n.id, "body": n.body, "pinned": n.pinned,
             "mentions": [user_ref(users[m]) for m in (n.mentions or []) if m in users],
             "author": user_ref(users.get(n.author_id)), "contact_id": n.contact_id, "deal_id": n.deal_id,
             "company_id": n.company_id, "created_at": n.created_at, "updated_at": n.updated_at} for n in notes]


def _mentions(db: Session, ctx, body: str) -> list[str]:
    members = team(db, ctx.organization_id, ctx.application_id)
    return list(dict.fromkeys(uid for _, uid in MENTION_RE.findall(body) if uid in members))


def list_notes(db: Session, ctx, *, contact_id=None, deal_id=None, company_id=None) -> list[dict]:
    ctx.require(Perm.CRM_READ)
    q = select(CrmNote).where(CrmNote.application_id == ctx.application_id)
    conds = [c for c in (contact_id and CrmNote.contact_id == contact_id, deal_id and CrmNote.deal_id == deal_id,
                         company_id and CrmNote.company_id == company_id) if c is not None and c is not False]
    if conds:
        q = q.where(or_(*conds))
    return notes_out(db, list(db.scalars(q.order_by(CrmNote.pinned.desc(), CrmNote.created_at.desc()).limit(200))))


def create_note(db: Session, ctx, data: NoteCreate) -> CrmNote:
    ctx.require(Perm.CRM_WRITE)
    contact, deal, company = _targets(db, ctx, data.contact_id, data.deal_id, data.company_id)
    n = CrmNote(organization_id=ctx.organization_id, application_id=ctx.application_id, body=data.body,
                pinned=data.pinned, mentions=_mentions(db, ctx, data.body), author_id=ctx.user.id,
                contact_id=contact.id if contact else None, deal_id=deal.id if deal else None,
                company_id=company.id if company else None)
    db.add(n)
    db.flush()
    touched(db, contact=contact, deal=deal)
    what = deal.title if deal else (contact_ref(contact)["name"] if contact else company.name)
    for uid in n.mentions:
        if uid != ctx.user.id:
            notify(db, uid, type_="crm_mention", title=f"{ctx.user.full_name} mentioned you on {what}"[:160],
                   body=MENTION_RE.sub(lambda m: "@" + m.group(1), n.body)[:300],
                   link=f"/apps/{ctx.application_id}" + (_link("deals", deal.id) if deal else _link(
                       "contacts", contact.id) if contact else _link("companies", company.id)),
                   organization_id=ctx.organization_id, application_id=ctx.application_id)
    return n


def update_note(db: Session, ctx, note_id: str, data: NoteUpdate) -> CrmNote:
    ctx.require(Perm.CRM_WRITE)
    n = get_in_app(db, ctx, CrmNote, note_id, "Note")
    if data.body is not None:
        if n.author_id != ctx.user.id:
            raise Forbidden("Only the author can edit a note", code="NOT_AUTHOR")
        n.body, n.mentions = data.body, _mentions(db, ctx, data.body)
    if data.pinned is not None:
        n.pinned = data.pinned
    return n


def delete_note(db: Session, ctx, note_id: str) -> None:
    ctx.require(Perm.CRM_WRITE)
    n = get_in_app(db, ctx, CrmNote, note_id, "Note")
    if n.author_id != ctx.user.id and not ctx.has(Perm.CRM_MANAGE):
        raise Forbidden("Only the author or a CRM manager can delete a note", code="NOT_AUTHOR")
    audit(db, ctx, "crm_note.deleted", "crm_note", n.id, "Deleted a note")
    db.delete(n)


# ------------------------------------------------------------------ activities

def log_activity(db: Session, ctx, data: ActivityCreate) -> CrmActivity:
    ctx.require(Perm.CRM_WRITE)
    contact, deal, company = _targets(db, ctx, data.contact_id, data.deal_id, data.company_id)
    at = data.occurred_at or utcnow()
    if at.tzinfo is not None:
        at = at.astimezone(utcnow().tzinfo)
    a = CrmActivity(organization_id=ctx.organization_id, application_id=ctx.application_id, type=data.type,
                    subject=data.subject.strip(), body=data.body, outcome=data.outcome,
                    duration_minutes=data.duration_minutes, occurred_at=at, actor_user_id=ctx.user.id,
                    contact_id=contact.id if contact else None, deal_id=deal.id if deal else None,
                    company_id=(company.id if company else (contact.company_id if contact else None)))
    db.add(a)
    db.flush()
    touched(db, contact=contact, deal=deal, at=min(at, utcnow()))
    return a


def delete_activity(db: Session, ctx, activity_id: str) -> None:
    ctx.require(Perm.CRM_WRITE)
    a = get_in_app(db, ctx, CrmActivity, activity_id, "Activity")
    if a.type == "system":
        raise ValidationFailed("System history can't be deleted", code="SYSTEM_ACTIVITY")
    if a.actor_user_id != ctx.user.id and not ctx.has(Perm.CRM_MANAGE):
        raise Forbidden("Only the person who logged it or a CRM manager can delete this", code="NOT_AUTHOR")
    db.delete(a)


# ------------------------------------------------------------------ timeline

EMAIL_LABELS = {"opened": "Opened email", "clicked": "Clicked a link", "bounced": "Email bounced",
                "complained": "Marked email as spam", "unsubscribed": "Unsubscribed from email",
                "delivered": "Email delivered"}


def _since(before: datetime | None):
    return before or utcnow() + timedelta(seconds=1)


def timeline(db: Session, ctx, *, contact_id: str | None = None, deal_id: str | None = None,
             company_id: str | None = None, before: datetime | None = None, limit: int = 50,
             kinds: set[str] | None = None) -> list[dict]:
    """Newest first. For a contact this includes campaign email/SMS/calls; for a deal or company it
    includes those of the linked contacts."""
    ctx.require(Perm.CRM_READ)
    contact = optional_in_app(db, ctx, Contact, contact_id, "Contact")
    deal = optional_in_app(db, ctx, Deal, deal_id, "Deal")
    company = optional_in_app(db, ctx, Company, company_id, "Company")
    if not (contact or deal or company):
        raise ValidationFailed("Choose a contact, deal or company", code="TARGET_REQUIRED")
    if contact:
        people = [contact.id]
    elif deal:
        people = [c for c in [deal.contact_id] if c]
    else:
        people = list(db.scalars(select(Contact.id).where(Contact.company_id == company.id).limit(200)))
    cutoff, items = _since(before), []
    want = kinds or {"activity", "note", "task", "system", "email", "sms", "call", "profile"}

    # CRM records attached to this object (and, for a contact, to its deals).
    def scope(model):
        conds = []
        if contact:
            conds.append(model.contact_id == contact.id)
        if deal:
            conds.append(model.deal_id == deal.id)
        if company:
            conds.append(model.company_id == company.id)
        return or_(*conds)

    if want & {"activity", "system"}:
        for a in db.scalars(select(CrmActivity).where(CrmActivity.application_id == ctx.application_id, scope(
                CrmActivity), CrmActivity.occurred_at < cutoff).order_by(CrmActivity.occurred_at.desc()).limit(limit)):
            kind = "system" if a.type == "system" else "activity"
            if kind in want:
                items.append({"id": a.id, "kind": kind, "type": a.type, "title": a.subject, "body": a.body,
                              "occurred_at": a.occurred_at, "actor_id": a.actor_user_id,
                              "meta": {"outcome": a.outcome, "duration_minutes": a.duration_minutes,
                                       "deal_id": a.deal_id, **(a.meta or {})}})
    if "note" in want:
        for n in db.scalars(select(CrmNote).where(CrmNote.application_id == ctx.application_id, scope(CrmNote),
                                                  CrmNote.created_at < cutoff).order_by(
                CrmNote.created_at.desc()).limit(limit)):
            items.append({"id": n.id, "kind": "note", "type": "note", "title": "Note", "body": n.body,
                          "occurred_at": n.created_at, "actor_id": n.author_id,
                          "meta": {"pinned": n.pinned, "deal_id": n.deal_id}})
    if "task" in want:
        for t in db.scalars(select(CrmTask).where(CrmTask.application_id == ctx.application_id, scope(CrmTask),
                                                  CrmTask.status == "done", CrmTask.completed_at < cutoff).order_by(
                CrmTask.completed_at.desc()).limit(limit)):
            items.append({"id": t.id, "kind": "task", "type": t.type, "title": f"Completed: {t.title}",
                          "body": t.notes, "occurred_at": t.completed_at, "actor_id": t.assignee_id, "meta": {}})
    if people and "email" in want:
        rows = db.execute(select(EmailMessage, EmailCampaign.name, EmailCampaign.subject).join(
            EmailCampaign, EmailCampaign.id == EmailMessage.campaign_id).where(
            EmailMessage.contact_id.in_(people), EmailMessage.status.notin_(("queued", "skipped")),
            EmailMessage.created_at < cutoff).order_by(EmailMessage.created_at.desc()).limit(limit)).all()
        for m, name, subject in rows:
            items.append({"id": m.id, "kind": "email", "type": "sent", "title": f"Email: {subject or name}",
                          "body": None, "occurred_at": m.created_at, "actor_id": None,
                          "meta": {"campaign": name, "status": m.status}})
        evs = db.execute(select(EmailEvent, EmailCampaign.name).join(
            EmailCampaign, EmailCampaign.id == EmailEvent.campaign_id).where(
            EmailEvent.contact_id.in_(people),
            EmailEvent.type.in_(("opened", "clicked", "bounced", "complained", "unsubscribed")),
            EmailEvent.occurred_at < cutoff).order_by(EmailEvent.occurred_at.desc()).limit(limit)).all()
        for e, name in evs:
            items.append({"id": e.id, "kind": "email", "type": e.type, "title": EMAIL_LABELS.get(e.type, e.type),
                          "body": None, "occurred_at": e.occurred_at, "actor_id": None, "meta": {"campaign": name}})
    if people and "sms" in want:
        rows = db.execute(select(SmsMessage, SmsCampaign.name).join(SmsCampaign, SmsCampaign.id == SmsMessage.campaign_id)
                          .where(SmsMessage.contact_id.in_(people), SmsMessage.status.notin_(
                              ("queued", "skipped", "deferred")), SmsMessage.created_at < cutoff)
                          .order_by(SmsMessage.created_at.desc()).limit(limit)).all()
        for m, name in rows:
            items.append({"id": m.id, "kind": "sms", "type": m.status, "title": f"SMS {m.status}",
                          "body": m.body, "occurred_at": m.created_at, "actor_id": None, "meta": {"campaign": name}})
        phones = list(db.scalars(select(Contact.phone).where(Contact.id.in_(people), Contact.phone.is_not(None))))
        if phones:
            for r in db.scalars(select(SmsInbound).where(SmsInbound.application_id == ctx.application_id,
                                                         SmsInbound.from_phone.in_(phones),
                                                         SmsInbound.received_at < cutoff)
                                .order_by(SmsInbound.received_at.desc()).limit(limit)):
                items.append({"id": r.id, "kind": "sms", "type": "reply", "title": "SMS reply", "body": r.body,
                              "occurred_at": r.received_at, "actor_id": None, "meta": {"keyword": r.keyword}})
    if people and "call" in want:
        rows = db.execute(select(VoiceCall, VoiceCampaign.name).join(VoiceCampaign, VoiceCampaign.id == VoiceCall.campaign_id)
                          .where(VoiceCall.contact_id.in_(people), VoiceCall.status.notin_(("queued", "skipped")),
                                 VoiceCall.created_at < cutoff)
                          .order_by(VoiceCall.created_at.desc()).limit(limit)).all()
        for c, name in rows:
            outcome = getattr(c, "outcome", None) or c.status
            items.append({"id": c.id, "kind": "call", "type": outcome, "title": f"Voice call: {outcome}".replace("_", " "),
                          "body": None, "occurred_at": c.created_at, "actor_id": None, "meta": {"campaign": name}})
    if contact and "profile" in want:
        # Audience history on the contact itself: created, imported, edited, consent given or withdrawn.
        for a in db.scalars(select(ContactActivity).where(
                ContactActivity.application_id == ctx.application_id, ContactActivity.contact_id == contact.id,
                ContactActivity.created_at < cutoff).order_by(ContactActivity.created_at.desc()).limit(limit)):
            items.append({"id": a.id, "kind": "profile", "type": a.type, "title": a.description, "body": None,
                          "occurred_at": a.created_at, "actor_id": a.actor_user_id, "meta": dict(a.meta or {})})
    items.sort(key=lambda x: x["occurred_at"], reverse=True)
    items = items[:limit]
    users = users_by_id(db, [i["actor_id"] for i in items])
    for i in items:
        i["actor"] = user_ref(users.get(i.pop("actor_id")))
    return items


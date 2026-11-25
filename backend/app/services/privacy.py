"""Data-subject rights for contacts (India DPDP Act 2023 / GDPR): full data export and erasure.

Export: everything held about one contact, as a ZIP with one complete JSON document plus CSVs.
Erasure: the contact is hard-deleted and every other place that holds their personal data is deleted or
irreversibly anonymised (messages, call logs and transcripts, chat visitors/transcripts, form submissions,
CRM notes/tasks/activities/deals that mention them, import rows/previews/files, raw provider webhooks).
Hashed suppression entries are kept so they are never re-imported or messaged again; aggregate counts
(campaign stats, form/chat analytics) survive because rows are anonymised rather than removed.

Both are logged in `data_requests` and the audit log, with counts only and never personal data.
"""
import csv
import io
import json
import re
import zipfile
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Text, cast, delete, func, or_, select, type_coerce, update
from sqlalchemy.orm import Session

from app.core.errors import NotFound, ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import (
    AuditLog,
    ChatBot,
    ChatConversation,
    ChatMessage,
    ChatVisitor,
    ConsentRecord,
    Contact,
    ContactActivity,
    ContactAttributeDefinition,
    ContactList,
    ContactListMember,
    ContactTag,
    CrmActivity,
    CrmEvent,
    CrmNote,
    CrmTask,
    DataRequest,
    Deal,
    DealContact,
    EmailCampaign,
    EmailEvent,
    EmailMessage,
    Import,
    ImportRow,
    LeadForm,
    LeadFormSubmission,
    SmsCampaign,
    SmsEvent,
    SmsInbound,
    SmsMessage,
    SuppressionEntry,
    Tag,
    User,
    VoiceCall,
    VoiceCampaign,
    VoiceEvent,
    WebhookEvent,
    Workflow,
    WorkflowRun,
    WorkflowStep,
)
from app.services import audit_service
from app.services.tenancy import AppContext, OrgContext
from app.utils.contact_normalize import mask_email, mask_phone
from app.utils.time import utcnow

log = get_logger(__name__)

ERASE_CONFIRMATION = "ERASE"
ERASED = "[erased]"
ERASED_ADDRESS = "erased"


# ---------------------------------------------------------------- helpers

def _contact(db: Session, ctx: AppContext, contact_id: str) -> Contact | None:
    return db.scalar(select(Contact).where(Contact.id == contact_id, Contact.application_id == ctx.application_id))


def _label(c: Contact) -> str:
    if c.email:
        return mask_email(c.email)
    if c.phone:
        return mask_phone(c.phone)
    return f"Contact {c.id[:8]}"


def _iso(v):
    if isinstance(v, datetime | date):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


def _row(obj, fields: list[str]) -> dict:
    return {f: _iso(getattr(obj, f)) for f in fields}


def _user_names(db: Session, ids: set) -> dict[str, str]:
    ids = {i for i in ids if i}
    return dict(db.execute(select(User.id, User.full_name).where(User.id.in_(ids))).all()) if ids else {}


class _Subject:
    """The identifiers by which personal data is recognised outside rows linked by contact_id."""

    def __init__(self, c: Contact):
        self.id = c.id
        self.email = (c.email or "").strip().lower() or None
        self.phone = c.phone or None
        digits = re.sub(r"\D", "", self.phone or "")
        # National significant number (last 10 digits, or all when shorter): matches "98765 43210", "+91-98765..."
        self.phone_digits = digits[-10:] if len(digits) >= 8 else None
        first, last = (c.first_name or "").strip(), (c.last_name or "").strip()
        full = f"{first} {last}".strip()
        # A name alone is only matched as a full "first last" pair, to avoid erasing other people's notes.
        self.full_name = full if first and last and len(full) >= 5 else None
        self.hashes = {h for h in (c.email_hash, c.phone_hash) if h}

    def like_terms(self) -> list[str]:
        return [t for t in (self.email, self.phone, self.full_name) if t]

    def mentioned_in(self, text: str | None) -> bool:
        if not text:
            return False
        low = text.lower()
        if self.email and self.email in low:
            return True
        if self.full_name and self.full_name.lower() in low:
            return True
        if self.phone_digits and self.phone_digits in re.sub(r"\D", "", text):
            return True
        return False

    def redact(self, text: str | None) -> str | None:
        if not text:
            return text
        out = text
        for term in (self.email, self.full_name, self.phone):
            if term:
                out = re.sub(re.escape(term), ERASED, out, flags=re.IGNORECASE)
        if self.phone_digits:
            # Formatted numbers: the national digits with any separators between them.
            pattern = r"(?:\+?\d{1,3}[\s\-.]?)?" + r"[\s\-.]?".join(re.escape(d) for d in self.phone_digits)
            out = re.sub(pattern, ERASED, out)
        return out

    def identifier_in(self, raw: dict | None) -> bool:
        """Raw rows (imports, form values) match on email or phone only (a shared name is not enough)."""
        for v in (raw or {}).values():
            s = str(v or "")
            if self.email and s.strip().lower() == self.email:
                return True
            if self.phone_digits and len(re.sub(r"\D", "", s)) >= 8 and \
                    re.sub(r"\D", "", s).endswith(self.phone_digits):
                return True
        return False


# ---------------------------------------------------------------- export

def collect(db: Session, ctx: AppContext, c: Contact) -> dict:
    """Everything held about one contact, as plain JSON-serialisable data."""
    app_id = ctx.application_id
    subject = _Subject(c)
    defs = {d.key: d for d in db.scalars(select(ContactAttributeDefinition).where(
        ContactAttributeDefinition.application_id == app_id))}
    profile = _row(c, ["id", "first_name", "last_name", "email", "phone", "phone_country", "phone_type", "company",
                       "country", "state", "city", "postal_code", "timezone", "source", "status", "lifecycle_stage",
                       "lead_score", "fit_score", "engagement_score", "email_consent", "sms_consent", "voice_consent",
                       "email_unsubscribed_at", "sms_unsubscribed_at", "voice_unsubscribed_at", "last_activity_at",
                       "created_at", "updated_at"])
    owners = _user_names(db, {c.owner_id})
    profile["owner"] = owners.get(c.owner_id)
    custom = [{"key": k, "label": defs[k].label if k in defs else k, "value": _iso(v)}
              for k, v in sorted((c.attributes or {}).items())]
    consents = [_row(r, ["channel", "status", "method", "source", "evidence", "consent_reference", "jurisdiction",
                         "ip_address", "created_at"])
                for r in db.scalars(select(ConsentRecord).where(ConsentRecord.contact_id == c.id)
                                    .order_by(ConsentRecord.created_at))]
    tags = list(db.scalars(select(Tag.name).join(ContactTag, ContactTag.tag_id == Tag.id)
                           .where(ContactTag.contact_id == c.id).order_by(Tag.name)))
    lists = list(db.scalars(select(ContactList.name).join(ContactListMember, ContactListMember.list_id == ContactList.id)
                            .where(ContactListMember.contact_id == c.id).order_by(ContactList.name)))
    suppressions = [_row(s, ["channel", "reason", "created_at"]) for s in db.scalars(select(SuppressionEntry).where(
        SuppressionEntry.application_id == app_id, SuppressionEntry.value_hash.in_(subject.hashes or {"-"})))]
    activity = [_row(a, ["type", "description", "created_at"]) for a in db.scalars(
        select(ContactActivity).where(ContactActivity.contact_id == c.id).order_by(ContactActivity.created_at))]

    # Email
    emails = list(db.scalars(select(EmailMessage).where(EmailMessage.application_id == app_id, or_(
        EmailMessage.contact_id == c.id, *( [EmailMessage.to_email == subject.email] if subject.email else []))
    ).order_by(EmailMessage.created_at)))
    camp = dict(db.execute(select(EmailCampaign.id, EmailCampaign.name).where(
        EmailCampaign.id.in_({m.campaign_id for m in emails} or {"-"}))).all())
    subj = dict(db.execute(select(EmailCampaign.id, EmailCampaign.subject).where(
        EmailCampaign.id.in_({m.campaign_id for m in emails} or {"-"}))).all())
    events: dict[str, list] = {}
    for e in db.scalars(select(EmailEvent).where(EmailEvent.message_id.in_({m.id for m in emails} or {"-"}))
                        .order_by(EmailEvent.occurred_at)):
        events.setdefault(e.message_id, []).append({"type": e.type, "url": e.url, "at": _iso(e.occurred_at)})
    email_out = [{**_row(m, ["to_email", "status", "created_at", "accepted_at", "delivered_at", "first_opened_at",
                             "first_clicked_at", "open_count", "click_count", "bounced_at", "unsubscribed_at"]),
                  "campaign": camp.get(m.campaign_id), "subject": subj.get(m.campaign_id),
                  "events": events.get(m.id, [])} for m in emails]

    # SMS
    phone_cond = [SmsMessage.to_phone == subject.phone] if subject.phone else []
    sms = list(db.scalars(select(SmsMessage).where(SmsMessage.application_id == app_id, or_(
        SmsMessage.contact_id == c.id, *phone_cond)).order_by(SmsMessage.created_at)))
    sms_camp = dict(db.execute(select(SmsCampaign.id, SmsCampaign.name).where(
        SmsCampaign.id.in_({m.campaign_id for m in sms} or {"-"}))).all())
    sms_out = [{**_row(m, ["to_phone", "body", "status", "segments", "created_at", "delivered_at", "failed_at"]),
                "campaign": sms_camp.get(m.campaign_id)} for m in sms]
    inbound_cond = [SmsInbound.from_phone == subject.phone] if subject.phone else []
    sms_in = [_row(m, ["from_phone", "body", "keyword", "received_at"]) for m in db.scalars(
        select(SmsInbound).where(SmsInbound.application_id == app_id, or_(SmsInbound.contact_id == c.id,
                                                                           *inbound_cond))
        .order_by(SmsInbound.received_at))]

    # Voice
    call_cond = [VoiceCall.to_phone == subject.phone] if subject.phone else []
    calls = list(db.scalars(select(VoiceCall).where(VoiceCall.application_id == app_id, or_(
        VoiceCall.contact_id == c.id, *call_cond)).order_by(VoiceCall.created_at)))
    v_camp = dict(db.execute(select(VoiceCampaign.id, VoiceCampaign.name).where(
        VoiceCampaign.id.in_({m.campaign_id for m in calls} or {"-"}))).all())
    calls_out = [{**_row(m, ["to_phone", "status", "answered_by", "answered_at", "ended_at", "duration_seconds",
                             "digits", "opted_out", "transcript", "ai_summary", "ai_sentiment", "ai_interest",
                             "ai_outcomes", "ai_next_step", "created_at"]),
                  "campaign": v_camp.get(m.campaign_id)} for m in calls]

    # Chat
    visitors = _chat_visitors(db, ctx, subject)
    convs = _chat_conversations(db, ctx, subject, {v.id for v in visitors})
    bots = dict(db.execute(select(ChatBot.id, ChatBot.name).where(
        ChatBot.id.in_({cv.bot_id for cv in convs} or {"-"}))).all())
    msgs: dict[str, list] = {}
    for m in db.scalars(select(ChatMessage).where(ChatMessage.conversation_id.in_({cv.id for cv in convs} or {"-"}),
                                                  ChatMessage.role != "note").order_by(ChatMessage.created_at)):
        msgs.setdefault(m.conversation_id, []).append({"role": m.role, "body": m.body, "at": _iso(m.created_at)})
    chat_out = [{**_row(cv, ["status", "page_url", "created_at", "closed_at", "rating", "rating_comment",
                             "ai_summary"]), "bot": bots.get(cv.bot_id), "messages": msgs.get(cv.id, [])}
                for cv in convs]
    visitors_out = [_row(v, ["name", "email", "phone", "attributes", "pages", "referrer", "utm", "ip_address",
                             "country", "user_agent", "first_seen_at", "last_seen_at"]) for v in visitors]

    # Forms
    subs = _form_submissions(db, ctx, subject)
    forms = dict(db.execute(select(LeadForm.id, LeadForm.name).where(
        LeadForm.id.in_({s.form_id for s in subs} or {"-"}))).all())
    subs_out = [{**_row(s, ["status", "values", "page_url", "referrer", "utm", "country", "user_agent",
                            "created_at", "confirmed_at"]), "form": forms.get(s.form_id)} for s in subs]

    # CRM
    notes = list(db.scalars(select(CrmNote).where(CrmNote.contact_id == c.id).order_by(CrmNote.created_at)))
    tasks = list(db.scalars(select(CrmTask).where(CrmTask.contact_id == c.id).order_by(CrmTask.created_at)))
    deal_ids = set(db.scalars(select(Deal.id).where(Deal.contact_id == c.id))) | set(
        db.scalars(select(DealContact.deal_id).where(DealContact.contact_id == c.id)))
    deals = list(db.scalars(select(Deal).where(Deal.id.in_(deal_ids or {"-"})).order_by(Deal.created_at)))
    acts = list(db.scalars(select(CrmActivity).where(CrmActivity.contact_id == c.id)
                           .order_by(CrmActivity.occurred_at)))
    users = _user_names(db, {n.author_id for n in notes} | {t.assignee_id for t in tasks} |
                        {a.actor_user_id for a in acts} | {d.owner_id for d in deals})
    crm = {
        "notes": [{**_row(n, ["body", "pinned", "created_at"]), "author": users.get(n.author_id)} for n in notes],
        "tasks": [{**_row(t, ["title", "type", "priority", "status", "due_at", "notes", "completed_at", "created_at"]),
                   "assignee": users.get(t.assignee_id)} for t in tasks],
        "deals": [{**_row(d, ["title", "amount", "currency", "status", "expected_close_date", "source", "created_at",
                              "closed_at"]), "owner": users.get(d.owner_id)} for d in deals],
        "activities": [{**_row(a, ["type", "subject", "body", "outcome", "duration_minutes", "occurred_at"]),
                        "by": users.get(a.actor_user_id)} for a in acts],
    }
    runs = list(db.scalars(select(WorkflowRun).where(WorkflowRun.contact_id == c.id)))
    wf = dict(db.execute(select(Workflow.id, Workflow.name).where(
        Workflow.id.in_({r.workflow_id for r in runs} or {"-"}))).all())
    automation = [{**_row(r, ["status", "started_at", "finished_at", "exit_reason"]),
                   "workflow": wf.get(r.workflow_id)} for r in runs]

    return {
        "export": {"generated_at": utcnow().isoformat(), "format_version": 1,
                   "application": {"id": ctx.application_id, "name": ctx.application.name},
                   "organization": {"id": ctx.organization_id, "name": ctx.organization.name},
                   "note": "All personal data held about this contact in this application."},
        "profile": profile, "custom_fields": custom, "consents": consents, "tags": tags, "lists": lists,
        "suppressions": suppressions, "activity": activity,
        "messages": {"email": email_out, "sms": sms_out, "sms_replies": sms_in, "voice_calls": calls_out,
                     "chat_conversations": chat_out},
        "chat_visitor_profiles": visitors_out, "form_submissions": subs_out, "crm": crm,
        "automation": automation,
    }


def _chat_visitors(db: Session, ctx: AppContext, s: _Subject) -> list[ChatVisitor]:
    conds = [ChatVisitor.contact_id == s.id]
    if s.email:
        conds.append(func.lower(ChatVisitor.email) == s.email)
    if s.phone:
        conds.append(ChatVisitor.phone == s.phone)
    return list(db.scalars(select(ChatVisitor).where(ChatVisitor.application_id == ctx.application_id, or_(*conds))))


def _chat_conversations(db: Session, ctx: AppContext, s: _Subject, visitor_ids: set[str]) -> list[ChatConversation]:
    return list(db.scalars(select(ChatConversation).where(
        ChatConversation.application_id == ctx.application_id,
        or_(ChatConversation.contact_id == s.id, ChatConversation.visitor_id.in_(visitor_ids or {"-"})))
        .order_by(ChatConversation.created_at)))


def _form_submissions(db: Session, ctx: AppContext, s: _Subject) -> list[LeadFormSubmission]:
    text = type_coerce(LeadFormSubmission.values, Text)
    conds = [LeadFormSubmission.contact_id == s.id]
    if s.email:
        conds.append(func.lower(text).like(f"%{s.email}%"))
    if s.phone_digits:
        conds.append(text.like(f"%{s.phone_digits[-6:]}%"))
    out = []
    for sub in db.scalars(select(LeadFormSubmission).where(LeadFormSubmission.application_id == ctx.application_id,
                                                           or_(*conds)).order_by(LeadFormSubmission.created_at)):
        if sub.contact_id == s.id or s.identifier_in(sub.values):
            out.append(sub)
    return out


def _csv(rows: list[dict], columns: list[str]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(columns)
    for r in rows:
        w.writerow(["" if r.get(k) is None else (json.dumps(r[k], ensure_ascii=False)
                                                 if isinstance(r[k], dict | list) else r[k]) for k in columns])
    return buf.getvalue()


def build_zip(data: dict) -> bytes:
    """contact.json (complete) plus one CSV per area for spreadsheet users."""
    msgs = data["messages"]
    flat_msgs = (
        [{"channel": "email", "direction": "outbound", "at": m["created_at"], "address": m["to_email"],
          "status": m["status"], "campaign": m["campaign"], "content": m["subject"]} for m in msgs["email"]]
        + [{"channel": "sms", "direction": "outbound", "at": m["created_at"], "address": m["to_phone"],
            "status": m["status"], "campaign": m["campaign"], "content": m["body"]} for m in msgs["sms"]]
        + [{"channel": "sms", "direction": "inbound", "at": m["received_at"], "address": m["from_phone"],
            "status": m["keyword"], "campaign": None, "content": m["body"]} for m in msgs["sms_replies"]]
        + [{"channel": "voice", "direction": "outbound", "at": m["created_at"], "address": m["to_phone"],
            "status": m["status"], "campaign": m["campaign"],
            "content": "\n".join(f"{t.get('role')}: {t.get('text')}" for t in (m["transcript"] or []))}
           for m in msgs["voice_calls"]]
        + [{"channel": "chat", "direction": x["role"], "at": x["at"], "address": None, "status": cv["status"],
            "campaign": cv["bot"], "content": x["body"]} for cv in msgs["chat_conversations"] for x in cv["messages"]]
    )
    profile_rows = [{"field": k, "value": v} for k, v in data["profile"].items()] + \
        [{"field": f"custom:{f['label']}", "value": f["value"]} for f in data["custom_fields"]] + \
        [{"field": "tags", "value": "; ".join(data["tags"])}, {"field": "lists", "value": "; ".join(data["lists"])}]
    crm = data["crm"]
    files = {
        "contact.json": json.dumps(data, ensure_ascii=False, indent=2, default=str),
        "profile.csv": _csv(profile_rows, ["field", "value"]),
        "consents.csv": _csv(data["consents"], ["created_at", "channel", "status", "method", "source", "evidence",
                                                "consent_reference", "jurisdiction", "ip_address"]),
        "messages.csv": _csv(sorted(flat_msgs, key=lambda r: str(r["at"] or "")),
                             ["at", "channel", "direction", "address", "status", "campaign", "content"]),
        "form_submissions.csv": _csv(data["form_submissions"], ["created_at", "form", "status", "values", "page_url",
                                                                "referrer", "country"]),
        "crm_notes.csv": _csv(crm["notes"], ["created_at", "author", "body"]),
        "crm_tasks.csv": _csv(crm["tasks"], ["created_at", "title", "type", "status", "due_at", "assignee", "notes"]),
        "crm_deals.csv": _csv(crm["deals"], ["created_at", "title", "amount", "currency", "status", "owner"]),
        "activities.csv": _csv(
            [{"at": a["occurred_at"], "kind": a["type"], "summary": a["subject"], "detail": a["body"], "by": a["by"]}
             for a in crm["activities"]] +
            [{"at": a["created_at"], "kind": a["type"], "summary": a["description"], "detail": None, "by": None}
             for a in data["activity"]], ["at", "kind", "summary", "detail", "by"]),
        "README.txt": ("Personal data export\n\ncontact.json holds everything; the CSV files are convenience views "
                       "of the same data.\nGenerated " + data["export"]["generated_at"] + "\n"),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, content in files.items():
            # utf-8-sig on CSVs so Excel opens non-ASCII names correctly.
            z.writestr(name, content.encode("utf-8-sig" if name.endswith(".csv") else "utf-8"))
    return buf.getvalue()


def export_contact(db: Session, ctx: AppContext, contact_id: str, ip: str | None) -> tuple[str, bytes]:
    ctx.require(Perm.PRIVACY_MANAGE)
    c = _contact(db, ctx, contact_id)
    if c is None:
        raise NotFound("Contact not found")
    data = collect(db, ctx, c)
    payload = build_zip(data)
    m = data["messages"]
    details = {"email": len(m["email"]), "sms": len(m["sms"]) + len(m["sms_replies"]), "voice": len(m["voice_calls"]),
               "chat": len(m["chat_conversations"]), "form_submissions": len(data["form_submissions"]),
               "consents": len(data["consents"]), "crm_notes": len(data["crm"]["notes"]),
               "crm_tasks": len(data["crm"]["tasks"]), "crm_deals": len(data["crm"]["deals"]),
               "activities": len(data["crm"]["activities"]) + len(data["activity"])}
    now = utcnow()
    db.add(DataRequest(organization_id=ctx.organization_id, application_id=ctx.application_id, contact_id=c.id,
                       kind="export", status="completed", subject_label=_label(c), requested_by_id=ctx.user.id,
                       details=details, created_at=now, completed_at=now))
    audit_service.record(db, "contact.data_exported", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="contact", target_id=c.id,
                         summary="Exported all data for a contact (data-subject request)", meta=details,
                         ip_address=ip)
    return f"contact-data-{c.id[:8]}-{now:%Y%m%d}.zip", payload


# ---------------------------------------------------------------- erasure

def _bump(counts: dict, key: str, n: int | None) -> None:
    if n:
        counts[key] = counts.get(key, 0) + int(n)


def _suppress_forever(db: Session, ctx: AppContext, c: Contact, counts: dict) -> None:
    """Keep hashed suppression entries (no raw value, no masked value) so the person is never messaged
    or re-imported again. Existing entries keep their reason but lose their masked address and note."""
    pairs = []
    if c.email_hash:
        pairs.append(("email", c.email_hash))
    if c.phone_hash:
        pairs += [("sms", c.phone_hash), ("voice", c.phone_hash)]
    for channel, h in pairs:
        existing = db.scalar(select(SuppressionEntry).where(
            SuppressionEntry.application_id == ctx.application_id, SuppressionEntry.channel == channel,
            SuppressionEntry.value_hash == h))
        if existing is not None:
            existing.value_masked = ERASED_ADDRESS
            existing.note = None
            if existing.reason == "unsubscribed":
                existing.reason = "erased"  # an explicit re-opt-in must not lift an erasure
        else:
            db.add(SuppressionEntry(organization_id=ctx.organization_id, application_id=ctx.application_id,
                                    channel=channel, value_hash=h, value_masked=ERASED_ADDRESS, reason="erased",
                                    source="Erasure request", created_by_id=ctx.user.id))
        _bump(counts, "suppression_entries", 1)


def _erase_messages(db: Session, ctx: AppContext, s: _Subject, counts: dict) -> None:
    app_id = ctx.application_id
    # Email: keep the rows (campaign statistics) without the address; events lose clicked URLs and metadata.
    conds = [EmailMessage.contact_id == s.id] + ([EmailMessage.to_email == s.email] if s.email else [])
    ids = list(db.scalars(select(EmailMessage.id).where(EmailMessage.application_id == app_id, or_(*conds))))
    if ids:
        _bump(counts, "email_messages", db.execute(update(EmailMessage).where(EmailMessage.id.in_(ids)).values(
            contact_id=None, to_email=ERASED_ADDRESS, error_message=None)).rowcount)
        db.execute(update(EmailEvent).where(EmailEvent.message_id.in_(ids)).values(contact_id=None, url=None, meta={}))
    # SMS (outbound, delivery events, inbound replies)
    phone = [SmsMessage.to_phone == s.phone] if s.phone else []
    ids = list(db.scalars(select(SmsMessage.id).where(SmsMessage.application_id == app_id,
                                                      or_(SmsMessage.contact_id == s.id, *phone))))
    if ids:
        _bump(counts, "sms_messages", db.execute(update(SmsMessage).where(SmsMessage.id.in_(ids)).values(
            contact_id=None, to_phone=ERASED_ADDRESS, body=None, error_message=None)).rowcount)
        db.execute(update(SmsEvent).where(SmsEvent.message_id.in_(ids)).values(contact_id=None, meta={}))
    phone = [SmsInbound.from_phone == s.phone] if s.phone else []
    _bump(counts, "sms_inbound", db.execute(update(SmsInbound).where(
        SmsInbound.application_id == app_id, or_(SmsInbound.contact_id == s.id, *phone)).values(
        contact_id=None, from_phone=ERASED_ADDRESS, body=ERASED)).rowcount)
    # Voice: call logs keep duration/cost for billing; transcripts and AI notes are removed.
    phone = [VoiceCall.to_phone == s.phone] if s.phone else []
    ids = list(db.scalars(select(VoiceCall.id).where(VoiceCall.application_id == app_id,
                                                     or_(VoiceCall.contact_id == s.id, *phone))))
    if ids:
        _bump(counts, "voice_calls", db.execute(update(VoiceCall).where(VoiceCall.id.in_(ids)).values(
            contact_id=None, to_phone=ERASED_ADDRESS, transcript=None, ai_summary=None, ai_outcomes=None,
            ai_next_step=None, ai_interest=None, ai_sentiment=None, digits=None, error_message=None)).rowcount)
        db.execute(update(VoiceEvent).where(VoiceEvent.call_id.in_(ids)).values(contact_id=None, meta={}))


def _erase_chat(db: Session, ctx: AppContext, s: _Subject, counts: dict) -> None:
    visitors = _chat_visitors(db, ctx, s)
    vids = {v.id for v in visitors}
    conv_ids = [cv.id for cv in _chat_conversations(db, ctx, s, vids)]
    if conv_ids:
        _bump(counts, "chat_messages", db.execute(update(ChatMessage).where(
            ChatMessage.conversation_id.in_(conv_ids)).values(body=ERASED, question=None, meta={})).rowcount)
        _bump(counts, "chat_conversations", db.execute(update(ChatConversation).where(
            ChatConversation.id.in_(conv_ids)).values(
            contact_id=None, page_url=None, page_title=None, last_message_preview=None, rating_comment=None,
            ai_summary=None, ai_intent=None, ai_follow_up=None, tags=[])).rowcount)
    if vids:
        _bump(counts, "chat_visitors", db.execute(update(ChatVisitor).where(ChatVisitor.id.in_(vids)).values(
            contact_id=None, name=None, email=None, phone=None, attributes={}, pages=[], referrer=None, utm={},
            ip_address=None, user_agent=None)).rowcount)


def _erase_forms(db: Session, ctx: AppContext, s: _Subject, counts: dict) -> None:
    ids = [sub.id for sub in _form_submissions(db, ctx, s)]
    if ids:
        _bump(counts, "form_submissions", db.execute(update(LeadFormSubmission).where(
            LeadFormSubmission.id.in_(ids)).values(contact_id=None, values={}, page_url=None, referrer=None, utm={},
                                                   ip_hash=None, user_agent=None)).rowcount)


def _redact_mentions(db: Session, ctx: AppContext, s: _Subject, counts: dict) -> None:
    """Notes, tasks, activities and deals about other records that mention this person by email, phone or
    full name. Rows linked to the contact itself are deleted with it."""
    terms = s.like_terms()
    if s.phone_digits:
        terms.append(s.phone_digits[-6:])
    if terms:
        targets = ((CrmNote, ("body",)), (CrmTask, ("title", "notes")), (CrmActivity, ("subject", "body")),
                   (Deal, ("title", "lost_note")))
        for model, fields in targets:
            conds = [func.lower(getattr(model, f)).like(f"%{t.lower()}%") for f in fields for t in terms]
            for row in db.scalars(select(model).where(model.application_id == ctx.application_id, or_(*conds))):
                changed = False
                for f in fields:
                    val = getattr(row, f)
                    if s.mentioned_in(val):
                        new = s.redact(val)
                        if new != val:
                            setattr(row, f, new or ERASED)
                            changed = True
                if changed:
                    _bump(counts, f"{model.__tablename__}_redacted", 1)
    # CRM events and automation history linked to the contact keep their shape, not their data.
    _bump(counts, "crm_events", db.execute(update(CrmEvent).where(
        CrmEvent.application_id == ctx.application_id, CrmEvent.contact_id == s.id).values(
        contact_id=None, data={})).rowcount)
    run_ids = list(db.scalars(select(WorkflowRun.id).where(WorkflowRun.application_id == ctx.application_id,
                                                           WorkflowRun.contact_id == s.id)))
    if run_ids:
        db.execute(update(WorkflowStep).where(WorkflowStep.run_id.in_(run_ids)).values(detail=None, meta=None))
        _bump(counts, "workflow_runs", db.execute(update(WorkflowRun).where(WorkflowRun.id.in_(run_ids)).values(
            contact_id=None, exit_reason=None)).rowcount)


def _erase_imports(db: Session, ctx: AppContext, s: _Subject, counts: dict) -> None:
    """Import rows keep raw values only for rows that were not imported (so they can be fixed); those, the
    upload preview and the stored source file can all still hold this person's data."""
    import_ids = list(db.scalars(select(Import.id).where(Import.application_id == ctx.application_id)))
    if not import_ids:
        return
    _bump(counts, "import_rows", db.execute(update(ImportRow).where(
        ImportRow.import_id.in_(import_ids), ImportRow.contact_id == s.id).values(contact_id=None, raw=None)).rowcount)
    terms = ([s.email] if s.email else []) + ([s.phone_digits[-4:]] if s.phone_digits else [])
    if terms:
        raw_text = func.lower(cast(ImportRow.raw, Text))
        q = select(ImportRow).where(ImportRow.import_id.in_(import_ids), ImportRow.raw.is_not(None),
                                    or_(*[raw_text.like(f"%{t}%") for t in terms]))
        for row in db.scalars(q):
            if s.identifier_in(row.raw):
                row.raw = None
                _bump(counts, "import_rows", 1)
    for imp in db.scalars(select(Import).where(Import.id.in_(import_ids))):
        preview = imp.preview or []
        kept = [r for r in preview if not s.identifier_in(r)]
        if len(kept) != len(preview):
            imp.preview = kept
            _bump(counts, "import_previews", 1)
        if imp.status in ("queued", "processing"):
            continue  # rewriting a file that is being read would shift its rows
        try:
            if _rewrite_import_file(imp, s):
                _bump(counts, "import_files", 1)
        except Exception:  # a missing or unreadable file holds nothing we can erase
            log.warning("erasure_import_file_unreadable", import_id=imp.id)


def _rewrite_import_file(imp: Import, s: _Subject) -> bool:
    """Rewrite a stored upload without this person's rows (as CSV)."""
    from app.integrations.storage import get_storage
    from app.services.audience import import_files

    storage = get_storage()
    headers, rows = import_files.iter_rows(storage.get(imp.file_key), imp.file_type)
    kept, dropped = [], 0
    for _, row in rows:
        if s.identifier_in(row):
            dropped += 1
        else:
            kept.append(row)
    if not dropped:
        return False
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=headers, extrasaction="ignore")
    w.writeheader()
    w.writerows(kept)
    data = buf.getvalue().encode("utf-8")
    new_key = imp.file_key.rsplit(".", 1)[0] + ".csv"
    storage.put(new_key, data, "text/csv")
    if new_key != imp.file_key:
        storage.delete(imp.file_key)
    imp.file_key, imp.file_type, imp.file_size = new_key, "csv", len(data)
    if imp.status == "uploaded":
        imp.total_rows = len(kept)
    return True


def _erase_elsewhere(db: Session, ctx: AppContext, s: _Subject, counts: dict) -> None:
    # Raw provider callbacks (bounces, delivery receipts, inbound SMS) carry the address in their payload.
    terms = [t for t in (s.email, s.phone) if t]
    if terms:
        text = func.lower(cast(WebhookEvent.payload, Text))
        _bump(counts, "webhook_events", db.execute(update(WebhookEvent).where(
            or_(*[text.like(f"%{t.lower()}%") for t in terms])).values(payload={"erased": True})
            .execution_options(synchronize_session=False)).rowcount)
    # Audit summaries are written without contact data, but scrub any that slipped through.
    terms = s.like_terms()
    if terms:
        _bump(counts, "audit_summaries", db.execute(update(AuditLog).where(
            AuditLog.organization_id == ctx.organization_id,
            or_(*[func.lower(AuditLog.summary).like(f"%{t.lower()}%") for t in terms])).values(
            summary=ERASED).execution_options(synchronize_session=False)).rowcount)
    # Earlier export entries showed a masked address: blank it.
    db.execute(update(DataRequest).where(DataRequest.application_id == ctx.application_id,
                                         DataRequest.contact_id == s.id).values(subject_label=None))


def erase_contact(db: Session, ctx: AppContext, contact_id: str, confirm: str, ip: str | None) -> dict:
    """Erase a contact everywhere. Idempotent: erasing an already-erased contact returns the earlier result."""
    ctx.require(Perm.PRIVACY_MANAGE)
    if (confirm or "").strip() != ERASE_CONFIRMATION:
        raise ValidationFailed(f'Type "{ERASE_CONFIRMATION}" to confirm', code="CONFIRMATION_REQUIRED")
    c = db.scalar(select(Contact).where(Contact.id == contact_id, Contact.application_id == ctx.application_id)
                  .with_for_update())
    if c is None:
        prior = db.scalar(select(DataRequest).where(
            DataRequest.application_id == ctx.application_id, DataRequest.contact_id == contact_id,
            DataRequest.kind == "erasure").order_by(DataRequest.created_at.desc()))
        if prior is None:
            raise NotFound("Contact not found")
        return {"contact_id": contact_id, "already_erased": True, "erased_at": prior.completed_at,
                "details": prior.details or {}}
    s = _Subject(c)
    counts: dict[str, int] = {}
    _suppress_forever(db, ctx, c, counts)
    _erase_messages(db, ctx, s, counts)
    _erase_chat(db, ctx, s, counts)
    _erase_forms(db, ctx, s, counts)
    _redact_mentions(db, ctx, s, counts)
    _erase_imports(db, ctx, s, counts)
    # Rows that belong to the contact are deleted outright: consents with their evidence, activity, CRM
    # notes/tasks/activities, tags, list memberships and deal participations.
    for model, key in ((ConsentRecord, "consent_records"), (ContactActivity, "contact_activities"),
                       (CrmNote, "crm_notes"), (CrmTask, "crm_tasks"), (CrmActivity, "crm_activities"),
                       (ContactTag, "tag_links"), (ContactListMember, "list_memberships"),
                       (DealContact, "deal_participations")):
        _bump(counts, key, db.execute(delete(model).where(model.contact_id == c.id)).rowcount)
    _bump(counts, "deals_unlinked", db.execute(update(Deal).where(Deal.contact_id == c.id).values(
        contact_id=None)).rowcount)
    db.execute(delete(Contact).where(Contact.id == c.id))
    db.expunge(c)
    counts["contacts"] = 1
    _erase_elsewhere(db, ctx, s, counts)
    now = utcnow()
    db.add(DataRequest(organization_id=ctx.organization_id, application_id=ctx.application_id, contact_id=contact_id,
                       kind="erasure", status="completed", subject_label=None, requested_by_id=ctx.user.id,
                       details=counts, created_at=now, completed_at=now))
    audit_service.record(db, "contact.erased", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="contact", target_id=contact_id,
                         summary="Erased a contact and their personal data (data-subject request)", meta=counts,
                         ip_address=ip)
    return {"contact_id": contact_id, "already_erased": False, "erased_at": now, "details": counts}


def is_erased(db: Session, application_id: str, hashes: list[str]) -> set[str]:
    """The subset of identifier hashes that belong to erased people in this application."""
    hashes = [h for h in hashes if h]
    if not hashes:
        return set()
    return set(db.scalars(select(SuppressionEntry.value_hash).where(
        SuppressionEntry.application_id == application_id, SuppressionEntry.reason == "erased",
        SuppressionEntry.value_hash.in_(hashes))))


# ---------------------------------------------------------------- org log

def list_requests(db: Session, ctx: OrgContext, page: int, page_size: int, kind: str | None) -> dict:
    from app.models import Application

    ctx.require(Perm.PRIVACY_MANAGE)
    q = select(DataRequest).where(DataRequest.organization_id == ctx.organization_id)
    if kind:
        q = q.where(DataRequest.kind == kind)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(DataRequest.created_at.desc()).offset((page - 1) * page_size).limit(page_size)))
    users = _user_names(db, {r.requested_by_id for r in rows})
    apps = dict(db.execute(select(Application.id, Application.name).where(
        Application.id.in_({r.application_id for r in rows} or {"-"}))).all())
    items = [{"id": r.id, "kind": r.kind, "status": r.status, "contact_id": r.contact_id,
              "subject_label": r.subject_label, "application_id": r.application_id,
              "application_name": apps.get(r.application_id), "requested_by_id": r.requested_by_id,
              "requested_by_name": users.get(r.requested_by_id), "details": r.details or {},
              "created_at": r.created_at, "completed_at": r.completed_at} for r in rows]
    return {"items": items, "total": total, "page": page, "page_size": page_size}

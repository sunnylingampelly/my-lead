"""Inbound SMS keywords (STOP / START / HELP).

Opt-out keywords are always honoured for every application that texts from the receiving sender
ID or number. START re-subscribes only someone who opted out by keyword (the reply itself is the
written evidence the US requires); it never grants consent to someone who never gave it.
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Application, Contact
from app.models.sms import SmsInbound, SmsMessage, SmsSender
from app.services.audience import consent as consent_svc
from app.services.email.events import Ctx
from app.services.sms import rules
from app.utils.contact_normalize import identifier_hash, mask_phone, parse_phone
from app.utils.time import utcnow


def keyword_of(body: str) -> str | None:
    word = (body or "").strip().split()[0].upper().strip(".!") if (body or "").strip() else ""
    if word in rules.STOP_WORDS:
        return "stop"
    if word in rules.START_WORDS:
        return "start"
    if word in rules.HELP_WORDS:
        return "help"
    return None


def handle(db: Session, *, from_phone: str, to_sender: str, body: str, provider: str, event_id: str,
           application_ids: list[str] | None = None) -> list[SmsInbound]:
    """Record an inbound message and apply its keyword. Returns the rows stored (one per application)."""
    parsed = parse_phone(from_phone, None)
    phone = parsed.e164 if parsed else from_phone
    q = select(SmsSender).where(SmsSender.sender_id == to_sender)
    if application_ids is not None:
        q = q.where(SmsSender.application_id.in_(application_ids))
    senders = list(db.scalars(q))
    keyword = keyword_of(body)
    stored = []
    for app_id in dict.fromkeys(s.application_id for s in senders):
        key = f"{provider}:{event_id}:{app_id}"[:128]
        if db.scalar(select(SmsInbound.id).where(SmsInbound.provider_event_id == key)):
            continue
        sender = next(s for s in senders if s.application_id == app_id)
        app = db.get(Application, app_id)
        ctx = Ctx(sender.organization_id, app_id, app)
        contacts = list(db.scalars(select(Contact).where(Contact.application_id == app_id, Contact.phone == phone)))
        updated = 0
        if keyword == "stop":
            for c in contacts:
                if c.sms_unsubscribed_at is None or c.sms_consent:
                    consent_svc.revoke(db, ctx, c, "sms", method="keyword", source=f"Replied {body.strip()[:20]}")
                    updated += 1
            if not contacts:
                # Unknown number: still never text it again from this application.
                consent_svc.suppress(db, ctx, "sms", identifier_hash(phone), mask_phone(phone), "unsubscribed",
                                     "keyword")
        elif keyword == "start":
            when = utcnow().strftime("%Y-%m-%d %H:%M UTC")
            for c in contacts:
                if c.sms_unsubscribed_at is not None:
                    if consent_svc.grant(db, ctx, c, "sms", method="keyword", source="Replied START",
                                         evidence=f"Inbound SMS 'START' from {mask_phone(phone)} to {to_sender} at "
                                                  f"{when}"):
                        updated += 1
        # Most recent text to this number (by contact when known: that lookup is indexed).
        who = (SmsMessage.contact_id.in_([x.id for x in contacts]) if contacts else SmsMessage.to_phone == phone)
        last = db.execute(select(SmsMessage.campaign_id, SmsMessage.contact_id).where(
            SmsMessage.application_id == app_id, who, SmsMessage.to_phone == phone)
            .order_by(SmsMessage.created_at.desc()).limit(1)).first()
        contact_id = contacts[0].id if contacts else None
        if last and last.contact_id and any(x.id == last.contact_id for x in contacts):
            contact_id = last.contact_id  # several contacts share the number: the one we texted
        row = SmsInbound(organization_id=sender.organization_id, application_id=app_id, from_phone=phone,
                         contact_id=contact_id, campaign_id=last.campaign_id if last else None,
                         to_sender=to_sender, body=(body or "")[:320], keyword=keyword, contacts_updated=updated,
                         provider=provider, provider_event_id=key)
        db.add(row)
        db.flush()
        stored.append(row)
    return stored

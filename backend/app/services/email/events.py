"""Apply normalised delivery and engagement events to messages.

Events can arrive late, twice or out of order (an open before the delivery receipt, a bounce
after "delivered"). Rules:
* Each provider event id is recorded once; duplicates are ignored.
* Status only moves forward by rank; bounces, complaints and failures are terminal.
* First-open and first-click times keep the earliest timestamp seen.
"""
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Application, Contact
from app.models.email import EmailEvent, EmailMessage
from app.services.audience import consent as consent_svc
from app.utils.contact_normalize import identifier_hash, mask_email
from app.utils.time import utcnow

RANK = {"queued": 0, "sending": 1, "accepted": 2, "delivered": 3, "skipped": 9, "failed": 9, "bounced": 9,
        "complained": 9}


@dataclass
class Ctx:
    """Tenant ids for the consent/suppression helpers (no user involved)."""

    organization_id: str
    application_id: str
    application: Application | None = None
    user: object | None = None


def _earliest(a: datetime | None, b: datetime) -> datetime:
    return b if a is None or b < a else a


def _advance(msg: EmailMessage, status: str) -> None:
    if RANK.get(msg.status, 0) >= 9:
        return
    if RANK[status] >= RANK.get(msg.status, 0):
        msg.status = status


def apply(db: Session, msg: EmailMessage, type_: str, *, occurred_at: datetime | None = None,
          provider: str | None = None, provider_event_id: str | None = None, url: str | None = None,
          bounce_type: str | None = None, meta: dict | None = None) -> bool:
    """Record one event. Returns False if it was a duplicate."""
    at = occurred_at or utcnow()
    if provider_event_id:
        dup = db.scalar(select(EmailEvent.id).where(EmailEvent.provider == provider,
                                                    EmailEvent.provider_event_id == provider_event_id))
        if dup:
            return False
    sp = db.begin_nested()
    try:
        db.add(EmailEvent(organization_id=msg.organization_id, application_id=msg.application_id,
                          campaign_id=msg.campaign_id, message_id=msg.id, contact_id=msg.contact_id, type=type_,
                          url=url, provider=provider, provider_event_id=provider_event_id, meta=meta or {},
                          occurred_at=at))
        db.flush()
        sp.commit()
    except IntegrityError:
        sp.rollback()  # concurrent duplicate
        return False

    ctx = Ctx(msg.organization_id, msg.application_id)
    contact = db.get(Contact, msg.contact_id) if msg.contact_id else None

    if type_ == "accepted":
        msg.accepted_at = _earliest(msg.accepted_at, at)
        _advance(msg, "accepted")
    elif type_ == "delivered":
        msg.delivered_at = _earliest(msg.delivered_at, at)
        _advance(msg, "delivered")
    elif type_ == "bounced":
        msg.bounced_at = _earliest(msg.bounced_at, at)
        msg.bounce_type = bounce_type or "hard"
        if msg.status not in ("complained",):
            msg.status = "bounced"
        if msg.bounce_type == "hard":
            consent_svc.suppress(db, ctx, "email", identifier_hash(msg.to_email), mask_email(msg.to_email),
                                 "bounced", provider or "provider")
            if contact is not None and contact.email == msg.to_email:
                contact.status = "bounced"
                consent_svc.record_activity(db, ctx, contact.id, "email_bounced",
                                            "Email hard-bounced; address suppressed", {"campaign_id": msg.campaign_id})
    elif type_ == "complained":
        msg.complained_at = _earliest(msg.complained_at, at)
        msg.status = "complained"
        consent_svc.suppress(db, ctx, "email", identifier_hash(msg.to_email), mask_email(msg.to_email),
                             "complaint", provider or "provider")
        if contact is not None and contact.email_consent:
            consent_svc.revoke(db, ctx, contact, "email", method="complaint", source="Marked as spam")
    elif type_ in ("opened", "clicked"):
        msg.first_opened_at = _earliest(msg.first_opened_at, at)
        if type_ == "opened":
            msg.open_count += 1
        else:
            msg.first_clicked_at = _earliest(msg.first_clicked_at, at)
            msg.click_count += 1
        _advance(msg, "delivered")  # engagement implies delivery
        msg.delivered_at = msg.delivered_at or at
        if contact is not None:
            if contact.last_activity_at is None or at > contact.last_activity_at:
                contact.last_activity_at = at
            first = (type_ == "opened" and msg.open_count == 1) or (type_ == "clicked" and msg.click_count == 1)
            if first:
                consent_svc.record_activity(db, ctx, contact.id, f"email_{type_}",
                                            "Opened an email" if type_ == "opened" else "Clicked a link in an email",
                                            {"campaign_id": msg.campaign_id, **({"url": url} if url else {})})
    elif type_ == "unsubscribed":
        msg.unsubscribed_at = _earliest(msg.unsubscribed_at, at)
        if contact is not None and contact.email == msg.to_email:
            if contact.email_unsubscribed_at is None:
                consent_svc.revoke(db, ctx, contact, "email", method="unsubscribe_link",
                                   source="Unsubscribe link in campaign email")
        else:
            consent_svc.suppress(db, ctx, "email", identifier_hash(msg.to_email), mask_email(msg.to_email),
                                 "unsubscribed", "unsubscribe_link")
    elif type_ == "failed":
        msg.status = "failed"
    return True

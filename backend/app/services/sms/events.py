"""Apply delivery receipts to SMS messages.

Receipts can arrive twice or out of order. Rules:
* Each provider event id is recorded once; duplicates are ignored.
* accepted only moves a message forward; delivered / undelivered / failed are final, except that a
  later final receipt replaces an earlier one (carriers sometimes correct a status).
* Carrier errors that mean "this person opted out" or "this number cannot receive SMS" update
  consent and suppression so the number is not texted again.
"""
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Application, Contact
from app.models.sms import SmsEvent, SmsMessage
from app.services.audience import consent as consent_svc
from app.services.email.events import Ctx
from app.utils.contact_normalize import identifier_hash, mask_phone
from app.utils.time import utcnow

FINAL = ("delivered", "undelivered", "failed")
RANK = {"queued": 0, "deferred": 0, "sending": 1, "accepted": 2}
# Error codes from SNS delivery status logs (see sns_receipts): opted out at AWS/carrier, or not a valid mobile.
OPTED_OUT_CODES = {"OPTED_OUT"}
UNREACHABLE_CODES = {"INVALID_NUMBER"}


def _ctx(db: Session, msg: SmsMessage) -> Ctx:
    return Ctx(msg.organization_id, msg.application_id, db.get(Application, msg.application_id))


def apply(db: Session, msg: SmsMessage, type_: str, *, occurred_at: datetime | None = None,
          provider: str | None = None, provider_event_id: str | None = None, error_code: str | None = None,
          error_message: str | None = None, meta: dict | None = None) -> bool:
    """Record one event. Returns False for duplicates and receipts that change nothing."""
    at = occurred_at or utcnow()
    if provider_event_id and db.scalar(select(SmsEvent.id).where(SmsEvent.provider == provider,
                                                                 SmsEvent.provider_event_id == provider_event_id)):
        return False
    sp = db.begin_nested()
    try:
        db.add(SmsEvent(organization_id=msg.organization_id, application_id=msg.application_id,
                        campaign_id=msg.campaign_id, message_id=msg.id, contact_id=msg.contact_id, type=type_,
                        provider=provider, provider_event_id=provider_event_id, error_code=error_code,
                        meta=meta or {}, occurred_at=at))
        sp.commit()
    except IntegrityError:
        sp.rollback()
        return False

    if type_ == "accepted":
        msg.accepted_at = msg.accepted_at or at
        if msg.status not in FINAL and RANK.get(msg.status, 0) < RANK["accepted"]:
            msg.status = "accepted"
    elif type_ in FINAL:
        last_final = msg.delivered_at if msg.status == "delivered" else msg.failed_at if msg.status in FINAL else None
        if msg.status in FINAL and last_final and at < last_final:
            return True  # an older receipt; keep the newer status
        msg.status = type_
        if type_ == "delivered":
            msg.delivered_at, msg.error_code, msg.error_message = at, None, None
        else:
            msg.failed_at = at
            msg.error_code = error_code or msg.error_code
            msg.error_message = (error_message or msg.error_message or "")[:500] or None
        if error_code in OPTED_OUT_CODES | UNREACHABLE_CODES:
            _carrier_feedback(db, msg, error_code)
    return True


def _carrier_feedback(db: Session, msg: SmsMessage, code: str) -> None:
    ctx = _ctx(db, msg)
    contact = db.get(Contact, msg.contact_id) if msg.contact_id else None
    if code in OPTED_OUT_CODES:
        if contact is not None and contact.phone == msg.to_phone:
            if contact.sms_unsubscribed_at is None:
                consent_svc.revoke(db, ctx, contact, "sms", method="carrier", source="Carrier reported an opt-out")
        else:
            consent_svc.suppress(db, ctx, "sms", identifier_hash(msg.to_phone), mask_phone(msg.to_phone),
                                 "unsubscribed", "carrier")
    else:
        consent_svc.suppress(db, ctx, "sms", identifier_hash(msg.to_phone), mask_phone(msg.to_phone), "invalid",
                             "carrier", note=f"Carrier error {code}")

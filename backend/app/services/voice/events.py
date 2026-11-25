"""Apply call progress events (from provider callbacks or the simulator) to calls.

* Each provider event id is recorded once; duplicates are ignored.
* Events for an earlier attempt (a different provider call id) never touch a newer attempt.
* No answer and busy are retried up to the campaign's attempt limit, after its retry delay.
* Pressing the opt-out key revokes voice consent and suppresses the number immediately.
"""
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Application, Contact
from app.models.voice import VoiceCall, VoiceCampaign, VoiceEvent
from app.services.audience import consent as consent_svc
from app.services.email.events import Ctx
from app.services.voice import rules
from app.utils.contact_normalize import identifier_hash, mask_phone
from app.utils.time import utcnow

FINAL = ("completed", "voicemail", "no_answer", "busy", "failed", "skipped")
RETRYABLE = ("no_answer", "busy")
PROGRESS = {"placed": "dialing", "ringing": "ringing", "answered": "in_progress"}
ORDER = {"placing": 0, "dialing": 1, "ringing": 2, "in_progress": 3}


def apply(db: Session, call: VoiceCall, type_: str, *, occurred_at: datetime | None = None,
          provider: str | None = None, provider_event_id: str | None = None, duration: int | None = None,
          answered_by: str | None = None, digits: str | None = None, error_code: str | None = None,
          error_message: str | None = None) -> bool:
    at = occurred_at or utcnow()
    if provider_event_id and db.scalar(select(VoiceEvent.id).where(VoiceEvent.provider == provider,
                                                                   VoiceEvent.provider_event_id == provider_event_id)):
        return False
    sp = db.begin_nested()
    try:
        db.add(VoiceEvent(organization_id=call.organization_id, application_id=call.application_id,
                          campaign_id=call.campaign_id, call_id=call.id, contact_id=call.contact_id, type=type_,
                          provider=provider, provider_event_id=provider_event_id, occurred_at=at,
                          meta={k: v for k, v in {"duration": duration, "answered_by": answered_by, "digits": digits,
                                                  "error_code": error_code}.items() if v is not None}))
        sp.commit()
    except IntegrityError:
        sp.rollback()
        return False

    if type_ == "keypress":
        call.digits = (digits or "")[:10]
        campaign = db.get(VoiceCampaign, call.campaign_id)
        if digits == rules.OPT_OUT_DIGIT and campaign and (campaign.snapshot or {}).get("opt_out_keypress", True):
            opt_out(db, call)
        return True
    if call.status in FINAL:
        return True
    if type_ in PROGRESS:
        new = PROGRESS[type_]
        if ORDER.get(new, 0) >= ORDER.get(call.status, 0):
            call.status = new
        if type_ == "answered":
            call.answered_at = call.answered_at or at
            call.answered_by = answered_by or call.answered_by
        return True

    # Final outcome of this attempt.
    call.ended_at = at
    if type_ == "completed":
        call.duration_seconds = int(duration or 0)
        call.answered_by = answered_by or call.answered_by
        if call.duration_seconds <= 0 and not call.answered_at:
            type_ = "no_answer"  # some carriers report an unanswered call as completed with no duration
    if type_ == "completed":
        call.status = "voicemail" if call.answered_by == "machine" else "completed"
        call.answered_at = call.answered_at or at
        call.billable_minutes = rules.billable_minutes(call.duration_seconds)
        unit, _ = rules.price_per_minute(call.country, ai=bool(call.agent_id))
        call.cost = Decimal(str(round(call.billable_minutes * unit, 4)))
        call.error_code = call.error_message = None
        return True
    campaign = db.get(VoiceCampaign, call.campaign_id)
    if (type_ in RETRYABLE and campaign is not None and call.attempts < campaign.max_attempts
            and campaign.status in ("sending", "paused")):
        call.status = "queued"
        call.next_attempt_at = at + timedelta(minutes=campaign.retry_delay_minutes)
        call.deferred_reason = f"retry_after_{type_}"
        call.error_code, call.error_message = type_, f"Attempt {call.attempts}: {type_.replace('_', ' ')}"
        return True
    call.status = type_ if type_ in FINAL else "failed"
    call.error_code = error_code or (type_ if type_ != "failed" else call.error_code)
    if error_message or type_ == "failed":
        call.error_message = (error_message or call.error_message or "Call failed")[:500]
    else:
        call.error_message = None
    return True


def opt_out(db: Session, call: VoiceCall, method: str = "keypress", source: str | None = None) -> None:
    if call.opted_out:
        return
    call.opted_out = True
    source = source or f"Pressed {rules.OPT_OUT_DIGIT} during a call"
    ctx = Ctx(call.organization_id, call.application_id, db.get(Application, call.application_id))
    contact = db.get(Contact, call.contact_id) if call.contact_id else None
    if contact is not None and contact.phone == call.to_phone:
        if contact.voice_unsubscribed_at is None or contact.voice_consent:
            consent_svc.revoke(db, ctx, contact, "voice", method=method, source=source)
    else:
        consent_svc.suppress(db, ctx, "voice", identifier_hash(call.to_phone), mask_phone(call.to_phone),
                             "unsubscribed", method)

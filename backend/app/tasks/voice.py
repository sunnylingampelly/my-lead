"""Celery tasks for voice campaigns and provider callbacks."""
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models.email import WebhookEvent
from app.models.voice import VoiceCall, VoiceCampaign
from app.utils.time import utcnow
from app.workers.celery_app import celery_app

log = get_logger(__name__)


def _continue_later(campaign_id: str, status: str) -> None:
    if settings.CELERY_TASK_ALWAYS_EAGER:
        return  # the local scheduler wakes campaigns whose calls are due
    if status.startswith("retry:"):
        continue_voice_campaign.apply_async(args=[campaign_id], countdown=min(int(status.split(":")[1]), 3600))
    elif status == "waiting":
        continue_voice_campaign.apply_async(args=[campaign_id], countdown=15)


@celery_app.task(name="app.tasks.voice.launch_voice_campaign", autoretry_for=(OperationalError,), retry_backoff=True,
                 max_retries=5)
def launch_voice_campaign(campaign_id: str) -> str:
    from app.services.voice.engine import launch

    status = launch(campaign_id)
    _continue_later(campaign_id, status)
    return status


@celery_app.task(name="app.tasks.voice.continue_voice_campaign", autoretry_for=(OperationalError,),
                 retry_backoff=True, max_retries=5)
def continue_voice_campaign(campaign_id: str) -> str:
    from app.services.voice.engine import run

    status = run(campaign_id)
    _continue_later(campaign_id, status)
    return status


@celery_app.task(name="app.tasks.voice.dispatch_due_voice_campaigns")
def dispatch_due_voice_campaigns() -> int:
    from app.services.voice.engine import dispatch_due

    return dispatch_due()


@celery_app.task(name="app.tasks.voice.resume_voice_campaigns")
def resume_voice_campaigns() -> int:
    from app.workers.dispatch import dispatch

    with SessionLocal() as db:
        rows = db.execute(select(VoiceCampaign.id, VoiceCampaign.status).where(
            VoiceCampaign.status.in_(("queued", "sending")))).all()
    for cid, status in rows:
        dispatch(launch_voice_campaign if status == "queued" else continue_voice_campaign, cid)
    return len(rows)


# Provider status → our event type.
TWILIO = {"initiated": "placed", "queued": "placed", "ringing": "ringing", "in-progress": "answered",
          "answered": "answered", "completed": "completed", "busy": "busy", "no-answer": "no_answer",
          "failed": "failed", "canceled": "failed"}
EXOTEL = {"completed": "completed", "busy": "busy", "no-answer": "no_answer", "failed": "failed",
          "canceled": "failed", "in-progress": "answered", "ringing": "ringing"}


@celery_app.task(name="app.tasks.voice.process_voice_webhook", autoretry_for=(OperationalError,),
                 retry_backoff=True, max_retries=5)
def process_voice_webhook(webhook_event_id: str) -> str:
    from app.services.voice import events

    with SessionLocal() as db:
        w = db.get(WebhookEvent, webhook_event_id)
        if w is None or w.status in ("processed", "ignored"):
            return w.status if w else "missing"
        p = w.payload
        provider = w.provider.removeprefix("voice_")
        mapping = TWILIO if provider in ("twilio", "telnyx") else EXOTEL if provider == "exotel" else None
        type_ = mapping.get(str(p.get("status", "")).lower()) if mapping else p.get("type")
        if p.get("call_ref"):
            # Telnyx: the call was identified by the signed token in the callback URL.
            call = db.get(VoiceCall, p["call_ref"])
            if call is not None and int(p.get("attempt") or 0) != call.attempts:
                call = None  # a late event from an earlier attempt
            elif call is not None and p.get("call_id"):
                call.provider_call_id = str(p["call_id"])
        else:
            call = db.scalar(select(VoiceCall).where(VoiceCall.provider == provider,
                                                     VoiceCall.provider_call_id == str(p.get("call_id"))))
        applied = False
        if call is not None and type_:
            answered_by = p.get("answered_by")
            if answered_by and answered_by.startswith("machine"):
                answered_by = "machine"
            elif answered_by:
                answered_by = "human"
            applied = events.apply(db, call, type_, provider=provider, provider_event_id=w.event_id,
                                   duration=int(p["duration"]) if str(p.get("duration") or "").isdigit() else None,
                                   answered_by=answered_by, digits=p.get("digits"),
                                   error_code=str(p["error_code"]) if p.get("error_code") else None)
        w.status = "processed" if applied else "ignored"
        if not applied:
            w.error = "No matching call, unknown status or duplicate"
        w.processed_at = utcnow()
        db.commit()
        return w.status

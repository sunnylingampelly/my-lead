"""Celery tasks for SMS campaigns and provider callbacks."""
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models.email import WebhookEvent
from app.models.sms import SmsCampaign, SmsMessage
from app.utils.time import utcnow
from app.workers.celery_app import celery_app

log = get_logger(__name__)


def _continue_later(campaign_id: str, status: str) -> None:
    # With Celery, deferred messages are picked up by a countdown task; without it, the local
    # scheduler (and Beat's dispatch task) wakes campaigns whose messages are due.
    if status.startswith("retry:") and not settings.CELERY_TASK_ALWAYS_EAGER:
        continue_sms_campaign.apply_async(args=[campaign_id], countdown=min(int(status.split(":")[1]), 3600))


@celery_app.task(name="app.tasks.sms.launch_sms_campaign", autoretry_for=(OperationalError,), retry_backoff=True,
                 max_retries=5)
def launch_sms_campaign(campaign_id: str) -> str:
    from app.services.sms.engine import launch

    status = launch(campaign_id)
    _continue_later(campaign_id, status)
    return status


@celery_app.task(name="app.tasks.sms.continue_sms_campaign", autoretry_for=(OperationalError,), retry_backoff=True,
                 max_retries=5)
def continue_sms_campaign(campaign_id: str) -> str:
    from app.services.sms.engine import send

    status = send(campaign_id, max_wait_seconds=60 if settings.CELERY_TASK_ALWAYS_EAGER and
                  settings.ENVIRONMENT != "test" else 0)
    _continue_later(campaign_id, status)
    return status


@celery_app.task(name="app.tasks.sms.dispatch_due_sms_campaigns")
def dispatch_due_sms_campaigns() -> int:
    from app.services.sms.engine import dispatch_due

    return dispatch_due()


@celery_app.task(name="app.tasks.sms.resume_sms_campaigns")
def resume_sms_campaigns() -> int:
    """After a restart, pick up campaigns that were mid-send."""
    from app.workers.dispatch import dispatch

    with SessionLocal() as db:
        rows = db.execute(select(SmsCampaign.id, SmsCampaign.status).where(
            SmsCampaign.status.in_(("queued", "sending")))).all()
    for cid, status in rows:
        dispatch(launch_sms_campaign if status == "queued" else continue_sms_campaign, cid)
    return len(rows)


STATUS_MAP = {
    "twilio": {"delivered": "delivered", "undelivered": "undelivered", "failed": "failed"},
    # MSG91 delivery report codes: 1 delivered, 2 failed, 9/16/17 rejected or DND/NDNC blocked.
    "msg91": {"1": "delivered", "2": "failed", "9": "undelivered", "16": "undelivered", "17": "undelivered",
              "delivered": "delivered", "failed": "failed", "rejected": "undelivered"},
}


@celery_app.task(name="app.tasks.sms.process_sms_webhook", autoretry_for=(OperationalError,), retry_backoff=True,
                 max_retries=5)
def process_sms_webhook(webhook_event_id: str) -> str:
    from app.services.sms import events, inbound

    with SessionLocal() as db:
        w = db.get(WebhookEvent, webhook_event_id)
        if w is None or w.status in ("processed", "ignored"):
            return w.status if w else "missing"
        p = w.payload
        provider = w.provider.removeprefix("sms_")
        applied = False
        if w.event_type == "inbound":
            applied = bool(inbound.handle(db, from_phone=p["from"], to_sender=p["to"], body=p.get("body", ""),
                                          provider=provider, event_id=w.event_id))
        else:
            for item in p.get("items", [p]):
                status = STATUS_MAP.get(provider, {}).get(str(item.get("status", "")).lower()) \
                    if provider != "simulation" else item.get("status")
                if status not in ("delivered", "undelivered", "failed"):
                    continue
                msg = db.scalar(select(SmsMessage).where(SmsMessage.provider == provider,
                                                         SmsMessage.provider_message_id == str(item.get("message_id"))))
                if msg is None:
                    continue
                if events.apply(db, msg, status, provider=provider,
                                provider_event_id=f"{item.get('message_id')}:{status}:{item.get('error_code') or ''}",
                                error_code=str(item["error_code"]) if item.get("error_code") else None,
                                error_message=item.get("error_message")):
                    applied = True
        w.status = "processed" if applied else "ignored"
        if not applied:
            w.error = "No matching message, unknown status or duplicate"
        w.processed_at = utcnow()
        db.commit()
        return w.status

"""Celery tasks for email campaigns and webhook processing."""
from sqlalchemy import select
from sqlalchemy.exc import OperationalError

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models.email import EmailCampaign, EmailMessage, WebhookEvent
from app.utils.time import utcnow
from app.workers.celery_app import celery_app

log = get_logger(__name__)


def _local_wait() -> float:
    # Docker-less development runs tasks on background threads, which can simply wait for retries.
    return 1800 if settings.CELERY_TASK_ALWAYS_EAGER and settings.ENVIRONMENT != "test" else 0


def _continue_later(campaign_id: str, status: str) -> None:
    if status.startswith("retry:") and not settings.CELERY_TASK_ALWAYS_EAGER:
        continue_email_campaign.apply_async(args=[campaign_id], countdown=int(status.split(":")[1]))


@celery_app.task(name="app.tasks.email.launch_email_campaign", autoretry_for=(OperationalError,),
                 retry_backoff=True, max_retries=5)
def launch_email_campaign(campaign_id: str) -> str:
    from app.services.email.engine import launch

    status = launch(campaign_id, max_wait_seconds=_local_wait())
    _continue_later(campaign_id, status)
    return status


@celery_app.task(name="app.tasks.email.continue_email_campaign", autoretry_for=(OperationalError,),
                 retry_backoff=True, max_retries=5)
def continue_email_campaign(campaign_id: str) -> str:
    from app.services.email.engine import send

    status = send(campaign_id, max_wait_seconds=_local_wait())
    _continue_later(campaign_id, status)
    return status


@celery_app.task(name="app.tasks.email.dispatch_due_email_campaigns")
def dispatch_due_email_campaigns() -> int:
    from app.services.email.engine import dispatch_due

    return dispatch_due()


@celery_app.task(name="app.tasks.email.resume_sending_campaigns")
def resume_sending_campaigns() -> int:
    """After a restart, pick up campaigns that were mid-send."""
    from app.workers.dispatch import dispatch

    with SessionLocal() as db:
        ids = list(db.scalars(select(EmailCampaign.id).where(EmailCampaign.status.in_(("queued", "sending")))))
        queued = set(db.scalars(select(EmailCampaign.id).where(EmailCampaign.status == "queued")))
    for i in ids:
        dispatch(launch_email_campaign if i in queued else continue_email_campaign, i)
    return len(ids)


@celery_app.task(name="app.tasks.email.process_webhook_event", autoretry_for=(OperationalError,),
                 retry_backoff=True, max_retries=5)
def process_webhook_event(webhook_event_id: str) -> str:
    from app.providers.email.webhooks import WebhookError, parse_brevo, parse_ses
    from app.services.email import events

    with SessionLocal() as db:
        w = db.get(WebhookEvent, webhook_event_id)
        if w is None or w.status in ("processed", "ignored"):
            return w.status if w else "missing"
        try:
            items = parse_ses(w.payload) if w.provider == "ses" else parse_brevo(w.payload) \
                if w.provider == "brevo" else []
            if w.provider == "simulation":
                from app.providers.email.webhooks import NormalizedEvent, _ts

                p = w.payload
                items = [NormalizedEvent(p["message_id"], p["type"], _ts(p.get("occurred_at")), w.event_id,
                                         url=p.get("url"), bounce_type=p.get("bounce_type"))]
        except WebhookError as exc:
            w.status, w.error, w.processed_at = "failed", str(exc)[:500], utcnow()
            db.commit()
            return "failed"
        applied = 0
        for ev in items:
            msg = db.scalar(select(EmailMessage).where(EmailMessage.provider_message_id == ev.provider_message_id,
                                                       EmailMessage.provider == w.provider))
            if msg is None:
                continue
            if events.apply(db, msg, ev.type, occurred_at=ev.occurred_at, provider=w.provider,
                            provider_event_id=ev.event_id, url=ev.url, bounce_type=ev.bounce_type):
                applied += 1
        w.status = "processed" if applied else "ignored"
        if not applied:
            w.error = "No matching message or duplicate event"
        w.processed_at = utcnow()
        db.commit()
        return w.status


@celery_app.task(name="app.tasks.email.check_sender_domains")
def check_sender_domains() -> dict:
    """Daily DNS authentication check (SPF, DKIM, DMARC, MX) of every sender domain."""
    from app.services.email.domains import refresh_all

    return refresh_all()

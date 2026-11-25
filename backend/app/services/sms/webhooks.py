"""Store SMS provider events once and queue them for background processing."""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.email import WebhookEvent


def store_event(db: Session, provider: str, event_id: str, event_type: str, payload: dict) -> bool:
    """Record an SMS provider event. Returns False for an empty id or one already stored."""
    if not event_id or db.scalar(select(WebhookEvent.id).where(WebhookEvent.provider == provider,
                                                               WebhookEvent.event_id == event_id[:255])):
        return False
    w = WebhookEvent(provider=provider, channel="sms", event_id=event_id[:255], event_type=event_type,
                     payload=payload, signature_valid=True)
    db.add(w)
    db.commit()
    from app.tasks.sms import process_sms_webhook
    from app.workers.dispatch import dispatch

    dispatch(process_sms_webhook, w.id)
    return True

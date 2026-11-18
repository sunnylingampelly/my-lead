"""Process verified payment webhooks stored in webhook_events."""
from sqlalchemy.exc import OperationalError

from app.core.database import SessionLocal
from app.models.email import WebhookEvent
from app.utils.time import utcnow
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.payments.process_payment_webhook", autoretry_for=(OperationalError,),
                 retry_backoff=True, max_retries=5)
def process_payment_webhook(webhook_event_id: str) -> str:
    from app.services.billing import payments

    with SessionLocal() as db:
        w = db.get(WebhookEvent, webhook_event_id)
        if w is None or w.status in ("processed", "ignored"):
            return w.status if w else "missing"
        p, result = w.payload, "ignored"
        if w.provider == "stripe":
            obj = ((p.get("data") or {}).get("object")) or {}
            meta = obj.get("metadata") or {}
            if w.event_type in ("checkout.session.completed", "checkout.session.async_payment_succeeded") \
                    and obj.get("payment_status") == "paid":
                result = payments.mark_paid(db, meta.get("payment_id") or obj.get("client_reference_id"), "stripe",
                                            obj.get("id"), obj.get("amount_total"), obj.get("currency"),
                                            obj.get("payment_intent"))
            elif w.event_type in ("checkout.session.expired", "checkout.session.async_payment_failed"):
                result = payments.mark_failed(db, "stripe", obj.get("id"), meta.get("payment_id"),
                                              w.event_type.rsplit(".", 1)[-1])
        elif w.provider == "razorpay":
            payload = p.get("payload") or {}
            link = (payload.get("payment_link") or {}).get("entity") or {}
            pay = (payload.get("payment") or {}).get("entity") or {}
            notes = link.get("notes") or {}
            if w.event_type == "payment_link.paid":
                result = payments.mark_paid(db, notes.get("payment_id") if isinstance(notes, dict) else None, "razorpay",
                                            link.get("id"), link.get("amount_paid") or pay.get("amount"),
                                            link.get("currency") or pay.get("currency"), pay.get("id"))
            elif w.event_type in ("payment_link.expired", "payment_link.cancelled"):
                result = payments.mark_failed(db, "razorpay", link.get("id"), None, w.event_type.rsplit(".", 1)[-1])
        ok = result in ("credited", "already_paid", "failed", "expired")
        w.status = "processed" if ok else "ignored"
        w.error = None if ok else result
        w.processed_at = utcnow()
        db.commit()
        return result

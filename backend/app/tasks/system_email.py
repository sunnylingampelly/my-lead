"""Background delivery of platform emails (verification, password reset, invitations).

The task receives already-rendered content so it never needs to load tokens from the database:
only token hashes are stored, so the raw link exists solely in this task payload.
"""
from app.core.config import settings
from app.core.logging import get_logger
from app.providers.email.base import OutboundEmail, TransientProviderError
from app.providers.email.factory import get_system_email_provider
from app.workers.celery_app import celery_app

log = get_logger(__name__)


@celery_app.task(
    name="app.tasks.system_email.send_system_email",
    bind=True,
    autoretry_for=(TransientProviderError,),
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
    max_retries=6,
)
def send_system_email(self, *, kind: str, to_email: str, to_name: str | None, subject: str, html: str, text: str,
                      idempotency_key: str | None = None) -> dict:
    provider = get_system_email_provider()
    result = provider.send(
        OutboundEmail(
            to_email=to_email,
            to_name=to_name,
            subject=subject,
            html=html,
            text=text,
            from_email=settings.SYSTEM_EMAIL_FROM_ADDRESS,
            from_name=settings.SYSTEM_EMAIL_FROM_NAME,
            tags=(f"system:{kind}",),
            idempotency_key=idempotency_key,
        )
    )
    # Never log the recipient address or content; the kind and provider id are enough to trace.
    log.info("system_email_dispatched", kind=kind, provider=result.provider, accepted=result.accepted,
             provider_message_id=result.provider_message_id, error_code=result.error_code)
    return {"accepted": result.accepted, "provider_message_id": result.provider_message_id}

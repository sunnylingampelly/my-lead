"""Queue platform emails. Call only after the database transaction committed."""
from app.core.logging import get_logger
from app.services.mail_templates import RenderedEmail

log = get_logger(__name__)


def enqueue_system_email(kind: str, to_email: str, to_name: str | None, email: RenderedEmail,
                         idempotency_key: str | None = None) -> bool:
    from app.tasks.system_email import send_system_email

    try:
        send_system_email.apply_async(
            kwargs=dict(kind=kind, to_email=to_email, to_name=to_name, subject=email.subject, html=email.html,
                        text=email.text, idempotency_key=idempotency_key),
        )
        return True
    except Exception:
        # The user can request the email again; a broker outage must not fail the request.
        log.exception("system_email_enqueue_failed", kind=kind)
        return False

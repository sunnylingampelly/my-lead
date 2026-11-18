from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditLog


def record(
    db: Session,
    action: str,
    *,
    actor_user_id: str | None = None,
    organization_id: str | None = None,
    application_id: str | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    summary: str | None = None,
    meta: dict[str, Any] | None = None,
    ip_address: str | None = None,
) -> AuditLog:
    """Add an audit entry to the current transaction. Never pass secrets or full contact data."""
    entry = AuditLog(
        action=action,
        actor_user_id=actor_user_id,
        organization_id=organization_id,
        application_id=application_id,
        target_type=target_type,
        target_id=target_id,
        summary=(summary or "")[:255] or None,
        meta=meta or {},
        ip_address=ip_address,
    )
    db.add(entry)
    return entry

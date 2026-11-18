"""Periodic housekeeping, scheduled by Celery Beat."""
from datetime import timedelta

from sqlalchemy import delete, or_, select, update

from app.core.database import session_scope
from app.core.logging import get_logger
from app.models import EmailVerification, Import, ImportRow, PasswordReset, UserSession
from app.utils.time import utcnow
from app.workers.celery_app import celery_app

log = get_logger(__name__)


@celery_app.task(name="app.tasks.maintenance.purge_expired_auth_records")
def purge_expired_auth_records() -> dict:
    """Data retention: drop expired/used one-time tokens and long-dead sessions."""
    now = utcnow()
    cutoff = now - timedelta(days=30)
    with session_scope() as db:
        v = db.execute(delete(EmailVerification).where(
            or_(EmailVerification.expires_at < now, EmailVerification.used_at.is_not(None)))).rowcount
        p = db.execute(delete(PasswordReset).where(
            or_(PasswordReset.expires_at < now, PasswordReset.used_at.is_not(None)))).rowcount
        s = db.execute(delete(UserSession).where(
            or_(UserSession.expires_at < cutoff, UserSession.revoked_at < cutoff))).rowcount
    log.info("purged_auth_records", verifications=v, resets=p, sessions=s)
    return {"verifications": v, "resets": p, "sessions": s}


@celery_app.task(name="app.tasks.maintenance.purge_import_row_data")
def purge_import_row_data(retention_days: int = 30) -> dict:
    """Data minimisation: raw values kept for failed import rows are cleared after the retention
    window. Outcomes and reasons stay for reporting."""
    cutoff = utcnow() - timedelta(days=retention_days)
    with session_scope() as db:
        ids = select(Import.id).where(Import.completed_at < cutoff)
        n = db.execute(update(ImportRow).where(ImportRow.import_id.in_(ids), ImportRow.raw.is_not(None))
                       .values(raw=None)).rowcount
    log.info("purged_import_row_data", rows=n)
    return {"rows": n}

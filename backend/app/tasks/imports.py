from datetime import timedelta

from sqlalchemy import or_, select
from sqlalchemy.exc import OperationalError

from app.core.database import session_scope
from app.models import Import
from app.utils.time import utcnow
from app.workers.celery_app import celery_app


@celery_app.task(
    name="app.tasks.imports.process_import",
    autoretry_for=(OperationalError, ConnectionError),
    retry_backoff=True,
    retry_backoff_max=300,
    max_retries=5,
)
def process_import(import_id: str) -> str:
    from app.services.audience.import_processor import run_import

    return run_import(import_id)


@celery_app.task(name="app.tasks.imports.resume_stalled_imports")
def resume_stalled_imports(stale_after_minutes: int = 5) -> int:
    """Re-dispatch imports whose worker died (no heartbeat). Safe because processing resumes
    from the first unrecorded row."""
    from app.workers.dispatch import dispatch

    cutoff = utcnow() - timedelta(minutes=stale_after_minutes)
    with session_scope() as db:
        ids = list(db.scalars(select(Import.id).where(
            Import.status.in_(("queued", "processing")),
            or_(Import.heartbeat_at.is_(None), Import.heartbeat_at < cutoff),
        )))
    for i in ids:
        dispatch(process_import, i)
    return len(ids)

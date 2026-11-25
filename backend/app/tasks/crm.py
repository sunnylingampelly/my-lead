"""Celery task for CRM background work: owner assignment, first-response SLA, rotting deals, task
reminders and lead scoring."""
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.crm.crm_tick")
def crm_tick() -> dict:
    from app.core.database import SessionLocal
    from app.services.crm.leads import tick

    with SessionLocal() as db:
        return tick(db)

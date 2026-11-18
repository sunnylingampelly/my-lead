"""Celery task that drives automation: enroll new contacts and move due runs forward."""
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.automation.automation_tick")
def automation_tick() -> dict:
    from app.services.automation.engine import tick

    return tick()

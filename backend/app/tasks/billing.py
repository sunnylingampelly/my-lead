"""Charge usage to wallets and release holds of finished campaigns."""
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.billing.settle_usage")
def settle_usage() -> dict:
    from app.services.billing.wallet import run_settlement

    return run_settlement()

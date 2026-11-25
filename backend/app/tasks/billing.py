"""Charge usage to wallets and release holds of finished campaigns."""
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.billing.settle_usage")
def settle_usage() -> dict:
    from app.services.billing.wallet import run_settlement

    return run_settlement()


@celery_app.task(name="app.tasks.billing.renew_subscriptions")
def renew_subscriptions() -> dict:
    from app.services.billing.subscriptions import run_renewals

    return run_renewals()

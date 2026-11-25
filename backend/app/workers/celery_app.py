"""Celery application shared by the worker and beat (scheduler) services."""
from celery import Celery
from celery.schedules import crontab

from app.core.config import settings
from app.core.logging import configure_logging

configure_logging(settings.LOG_LEVEL, settings.LOG_JSON)

celery_app = Celery(
    "signalcraft",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["app.tasks.system_email", "app.tasks.maintenance", "app.tasks.imports", "app.tasks.email", "app.tasks.sms",
             "app.tasks.voice", "app.tasks.automation", "app.tasks.billing", "app.tasks.payments", "app.tasks.crm",
             "app.tasks.chat"],
)

celery_app.conf.update(
    task_always_eager=settings.CELERY_TASK_ALWAYS_EAGER,
    task_eager_propagates=False,
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    result_expires=3600,
    timezone="UTC",
    enable_utc=True,
    # Reliability: acknowledge only after the task finished so a crashed worker's task is redelivered.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    worker_prefetch_multiplier=1,
    broker_connection_retry_on_startup=True,
    task_default_queue="default",
    task_routes={
        "app.tasks.system_email.*": {"queue": "email"},
        "app.tasks.maintenance.*": {"queue": "default"},
        "app.tasks.imports.*": {"queue": "imports"},
        "app.tasks.email.*": {"queue": "campaigns"},
        "app.tasks.sms.*": {"queue": "campaigns"},
        "app.tasks.voice.*": {"queue": "campaigns"},
        "app.tasks.automation.*": {"queue": "campaigns"},
        "app.tasks.crm.*": {"queue": "default"},
        "app.tasks.chat.*": {"queue": "default"},
        "app.tasks.billing.*": {"queue": "default"},
        "app.tasks.payments.*": {"queue": "webhooks"},
    },
    beat_schedule={
        "dispatch-due-email-campaigns": {
            "task": "app.tasks.email.dispatch_due_email_campaigns",
            "schedule": 60.0,
        },
        "dispatch-due-sms-campaigns": {
            "task": "app.tasks.sms.dispatch_due_sms_campaigns",
            "schedule": 60.0,
        },
        "poll-sns-sms-receipts": {
            "task": "app.tasks.sms.poll_sns_receipts",
            "schedule": 60.0,
        },
        "dispatch-due-voice-campaigns": {
            "task": "app.tasks.voice.dispatch_due_voice_campaigns",
            "schedule": 30.0,
        },
        "sweep-ai-calls": {
            "task": "app.tasks.voice.sweep_ai_calls",
            "schedule": 300.0,
        },
        "crm-tick": {
            "task": "app.tasks.crm.crm_tick",
            "schedule": 60.0,
        },
        "chat-tick": {
            "task": "app.tasks.chat.chat_tick",
            "schedule": 60.0,
        },
        "automation-tick": {
            "task": "app.tasks.automation.automation_tick",
            "schedule": 20.0,
        },
        "settle-usage": {
            "task": "app.tasks.billing.settle_usage",
            "schedule": 60.0,
        },
        "renew-subscriptions": {
            "task": "app.tasks.billing.renew_subscriptions",
            "schedule": crontab(minute="*/10"),
        },
        "resume-stalled-imports": {
            "task": "app.tasks.imports.resume_stalled_imports",
            "schedule": crontab(minute="*/5"),
        },
        "purge-import-row-data": {
            "task": "app.tasks.maintenance.purge_import_row_data",
            "schedule": crontab(minute=43, hour=3),
        },
        "purge-expired-auth-records": {
            "task": "app.tasks.maintenance.purge_expired_auth_records",
            "schedule": crontab(minute=17, hour="*/6"),
        },
    },
)

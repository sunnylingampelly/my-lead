"""Celery task for website chat housekeeping: close idle chats and fill in missing post-chat summaries."""
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.chat.chat_tick")
def chat_tick() -> dict:
    from app.services.chat.conversations import tick_job

    return tick_job()

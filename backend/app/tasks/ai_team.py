"""Celery tasks for AI agents: the minute tick (event triggers, schedules, expired approvals, queued runs) and
running one agent run right away ("Run now")."""
from app.workers.celery_app import celery_app


@celery_app.task(name="app.tasks.ai_team.ai_team_tick")
def ai_team_tick() -> dict:
    from app.services.ai_team.runner import tick

    return tick()


@celery_app.task(name="app.tasks.ai_team.run_agent")
def run_agent(run_id: str) -> str | None:
    from app.services.ai_team.runner import claim_and_execute

    return claim_and_execute(run_id)

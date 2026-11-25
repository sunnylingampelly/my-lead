"""Fair-use daily limits for the AI Team (per organization, per UTC day).

Assistant messages and agent runs (including automation AI steps) are included in both plans up to the
plan's daily limit (billing/plans.py: ai_assistant_messages_per_day, ai_agent_runs_per_day). Actions the AI
triggers (emails, calls) are charged to the wallet as usual by the services that perform them."""
from datetime import date

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.models.ai_team import AiUsageCounter
from app.services.billing import plans
from app.utils.time import utcnow

ASSISTANT = "assistant_messages"
AGENT_RUNS = "agent_runs"
LIMIT_KEYS = {ASSISTANT: "ai_assistant_messages_per_day", AGENT_RUNS: "ai_agent_runs_per_day"}


def today() -> date:
    return utcnow().date()


def used(db: Session, organization_id: str, kind: str, day: date | None = None) -> int:
    return db.scalar(select(AiUsageCounter.count).where(
        AiUsageCounter.organization_id == organization_id, AiUsageCounter.day == (day or today()),
        AiUsageCounter.kind == kind)) or 0


def limit_for(db: Session, organization_id: str, kind: str) -> int | None:
    return plans.limit(db, organization_id, LIMIT_KEYS[kind])


def limit_message(db: Session, organization_id: str, kind: str) -> str:
    plan = plans.current_plan(db, organization_id)
    cap = plan["limits"].get(LIMIT_KEYS[kind])
    what = "AI Assistant messages" if kind == ASSISTANT else "AI agent runs"
    hint = " Upgrade to Pro for 10x more, or" if plan["key"] == plans.STARTER else ""
    return (f"You've used today's {cap:,} {what} on the {plan['name']} plan.{hint} "
            "try again tomorrow (limits reset at midnight UTC).")


def try_consume(db: Session, organization_id: str, kind: str) -> bool:
    """Count one use if the organization is under today's limit. Atomic, so parallel requests can't overshoot."""
    cap = limit_for(db, organization_id, kind)
    day = today()
    for _ in range(2):
        q = update(AiUsageCounter).where(AiUsageCounter.organization_id == organization_id,
                                         AiUsageCounter.day == day, AiUsageCounter.kind == kind)
        if cap is not None:
            q = q.where(AiUsageCounter.count < cap)
        if db.execute(q.values(count=AiUsageCounter.count + 1)).rowcount:
            return True
        exists = db.scalar(select(AiUsageCounter.id).where(AiUsageCounter.organization_id == organization_id,
                                                           AiUsageCounter.day == day, AiUsageCounter.kind == kind))
        if exists:
            return False  # at the limit
        if cap is not None and cap <= 0:
            return False
        try:
            with db.begin_nested():
                db.add(AiUsageCounter(organization_id=organization_id, day=day, kind=kind, count=1))
            return True
        except IntegrityError:
            continue  # another request created today's row first: retry the update
    return False


def consume_or_raise(db: Session, organization_id: str, kind: str) -> None:
    if not try_consume(db, organization_id, kind):
        raise ValidationFailed(limit_message(db, organization_id, kind), code="AI_DAILY_LIMIT")


# Today's use shows next to the plan's daily limits on the billing page.
plans.register_usage_counter(LIMIT_KEYS[ASSISTANT], lambda db, org_id: used(db, org_id, ASSISTANT))
plans.register_usage_counter(LIMIT_KEYS[AGENT_RUNS], lambda db, org_id: used(db, org_id, AGENT_RUNS))


def summary(db: Session, organization_id: str) -> dict:
    out = {}
    for kind in (ASSISTANT, AGENT_RUNS):
        out[kind] = {"used": used(db, organization_id, kind), "limit": limit_for(db, organization_id, kind)}
    out["plan"] = plans.current_plan(db, organization_id)["key"]
    return out

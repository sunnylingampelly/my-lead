"""Plans: Starter and Pro, on top of the prepaid wallet (pay as you go).

Model
* Every organization has a prepaid wallet in its own currency (INR for India, AED for the UAE, USD otherwise). All usage
  (email, SMS, voice minutes, AI-agent minutes) and the Pro fee is debited from it.
* Starter costs nothing per month: standard usage rates and modest limits.
* Pro has a monthly fee, debited from the wallet, with lower usage rates and higher limits.
* Calls come from Signalcraft-managed numbers: customers never rent or pay for phone numbers.
  Voice is charged per minute only.

This module is the single contract other modules use. Callers never read plan prices or limits
from anywhere else:
    current_plan(db, org_id) -> dict           # one of PLANS, plus "status"
    limit(db, org_id, key) -> int | None       # None = unlimited
    check_limit(db, org_id, key, used) -> None # raises ValidationFailed(code="PLAN_LIMIT")
    usage_multiplier(db, org_id) -> Decimal    # applied to usage charges (Pro discount)
    plan_price(plan_key, currency) -> Decimal
    register_usage_counter(key, fn) / count_usage(db, org_id, key) / usage(db, org_id)

Subscriptions (upgrade, scheduled downgrade, monthly renewal, past due and grace) and the generic
recurring-charge helper live in services/billing/subscriptions.py.
"""
from collections.abc import Callable
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed

STARTER, PRO = "starter", "pro"

PLANS: dict[str, dict] = {
    STARTER: {
        "key": STARTER,
        "name": "Starter",
        "tagline": "Pay only for what you send. No monthly fee.",
        "price": {"INR": Decimal("0"), "AED": Decimal("0"), "USD": Decimal("0")},
        "usage_discount": Decimal("0"),
        "limits": {"applications": 2, "members": 3, "voice_agents": 1, "contacts": 10_000,
                   "lead_forms": 3, "chatbots": 1, "chat_seats": 2,
                   "ai_assistant_messages_per_day": 50, "ai_agent_runs_per_day": 100},
        "features": ["Email, SMS and voice campaigns", "CRM and automation", "1 AI calling agent",
                     "3 lead forms", "1 website chatbot, 2 live-chat agents", "Up to 3 team members",
                     "AI Team: 50 assistant messages and 100 agent runs a day"],
        # Lead forms carry Signalcraft branding on Starter.
        "form_branding": True,
    },
    PRO: {
        "key": PRO,
        "name": "Pro",
        "tagline": "Lower rates and room to grow.",
        "price": {"INR": Decimal("2999"), "AED": Decimal("179"), "USD": Decimal("49")},
        "usage_discount": Decimal("0.20"),
        "limits": {"applications": 10, "members": 25, "voice_agents": 20, "contacts": None,
                   "lead_forms": None, "chatbots": 10, "chat_seats": 25,
                   "ai_assistant_messages_per_day": 500, "ai_agent_runs_per_day": 2000},
        "features": ["Everything in Starter", "20% off all usage", "Up to 20 AI calling agents", "Up to 25 team members",
                     "Unlimited contacts", "Unlimited lead forms, no Signalcraft branding",
                     "10 website chatbots, 25 live-chat agents",
                     "AI Team: 500 assistant messages and 2,000 agent runs a day"],
        "form_branding": False,
    },
}

LIMIT_LABELS = {"applications": "applications", "members": "team members", "voice_agents": "AI agents",
                "contacts": "contacts", "lead_forms": "lead forms", "chatbots": "chatbots",
                "chat_seats": "live-chat agents", "ai_assistant_messages_per_day": "AI Assistant messages a day",
                "ai_agent_runs_per_day": "AI agent runs a day"}

# Grace period after a failed Pro renewal before the organization moves to Starter.
GRACE_DAYS = 7


def current_plan(db: Session, organization_id: str) -> dict:
    """The organization's plan, with its subscription status (active | past_due)."""
    from app.services.billing import subscriptions  # persistence lives there

    sub = subscriptions.get(db, organization_id)
    plan = dict(PLANS.get(sub.plan if sub else STARTER, PLANS[STARTER]))
    plan["status"] = sub.status if sub else "active"
    return plan


def limit(db: Session, organization_id: str, key: str) -> int | None:
    return current_plan(db, organization_id)["limits"].get(key)


def check_limit(db: Session, organization_id: str, key: str, used: int) -> None:
    """Call before creating one more of `key`, with the number already in use."""
    plan = current_plan(db, organization_id)
    cap = plan["limits"].get(key)
    if cap is not None and used >= cap:
        what = LIMIT_LABELS.get(key, key)
        hint = " Upgrade to Pro for more." if plan["key"] == STARTER else ""
        raise ValidationFailed(f"Your {plan['name']} plan allows {cap} {what}.{hint}", code="PLAN_LIMIT")


def usage_multiplier(db: Session, organization_id: str) -> Decimal:
    return Decimal("1") - current_plan(db, organization_id)["usage_discount"]


def plan_price(plan_key: str, currency: str) -> Decimal:
    return PLANS[plan_key]["price"].get(currency, PLANS[plan_key]["price"]["USD"])


# ------------------------------------------------------------------ usage counters
# How much of each limit an organization uses. applications / members / contacts are counted here;
# other modules (e.g. voice: voice_agents) add theirs with register_usage_counter().

UsageCounter = Callable[[Session, str], int]
_USAGE_COUNTERS: dict[str, UsageCounter] = {}


def register_usage_counter(key: str, fn: UsageCounter) -> None:
    """fn(db, organization_id) -> how many of `key` the organization uses now."""
    _USAGE_COUNTERS[key] = fn


def count_usage(db: Session, organization_id: str, key: str) -> int:
    fn = _USAGE_COUNTERS.get(key)
    return int(fn(db, organization_id)) if fn else 0


def usage(db: Session, organization_id: str) -> dict[str, int]:
    """Every registered counter, for the plan page's usage-vs-limit meters."""
    return {key: count_usage(db, organization_id, key) for key in _USAGE_COUNTERS}


def _count_applications(db: Session, organization_id: str) -> int:
    from app.models import Application

    return db.scalar(select(func.count(Application.id)).where(Application.organization_id == organization_id,
                                                              Application.deleted_at.is_(None))) or 0


def _count_members(db: Session, organization_id: str) -> int:
    """Members plus pending (unexpired) invitations: an invitation reserves a seat."""
    from app.models import Invitation, OrganizationMember
    from app.utils.time import utcnow

    members = db.scalar(select(func.count(OrganizationMember.id)).where(
        OrganizationMember.organization_id == organization_id)) or 0
    pending = db.scalar(select(func.count(Invitation.id)).where(
        Invitation.organization_id == organization_id, Invitation.status == "pending",
        Invitation.expires_at > utcnow())) or 0
    return members + pending


def _count_contacts(db: Session, organization_id: str) -> int:
    from app.models import Contact

    return db.scalar(select(func.count(Contact.id)).where(Contact.organization_id == organization_id)) or 0


register_usage_counter("applications", _count_applications)
register_usage_counter("members", _count_members)
register_usage_counter("contacts", _count_contacts)

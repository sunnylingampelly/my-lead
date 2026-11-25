"""Shared CRM helpers: the application's sales team, record lookups scoped to the application,
default pipeline and lost reasons, the CRM event log, and "a human touched this record"."""
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import ORG_WIDE_ROLES, Perm, Role, permissions_for
from app.models import (
    ApplicationMember,
    Company,
    Contact,
    CrmActivity,
    CrmEvent,
    CrmSettings,
    Deal,
    LostReason,
    OrganizationMember,
    Pipeline,
    PipelineStage,
    User,
)
from app.services import audit_service
from app.services.tenancy import effective_app_role
from app.utils.time import utcnow

DEFAULT_STAGES = (
    ("New", 10, "open", 7), ("Qualified", 25, "open", 10), ("Proposal sent", 50, "open", 14),
    ("Negotiation", 75, "open", 14), ("Won", 100, "won", None), ("Lost", 0, "lost", None),
)
DEFAULT_LOST_REASONS = ("Price too high", "Chose a competitor", "No budget", "No response", "Not a fit",
                        "Timing / postponed")


def currency_for(ctx) -> str:
    country = (getattr(ctx.application, "default_country", None) or "").upper()
    return "INR" if country == "IN" or not country else "USD"


def audit(db: Session, ctx, action: str, target_type: str, target_id: str, summary: str, meta: dict | None = None):
    audit_service.record(db, action, actor_user_id=ctx.user.id if ctx.user else None,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type=target_type, target_id=target_id, summary=summary[:255], meta=meta or {})


# ------------------------------------------------------------------ team

def team(db: Session, organization_id: str, application_id: str) -> dict[str, User]:
    """Users who can work CRM records in this application (they hold crm.write here)."""
    rows = db.execute(select(OrganizationMember, User).join(User, User.id == OrganizationMember.user_id).where(
        OrganizationMember.organization_id == organization_id)).all()
    app_members = {m.user_id: m for m in db.scalars(select(ApplicationMember).where(
        ApplicationMember.application_id == application_id))}
    out = {}
    for om, u in rows:
        role = Role(om.role_key)
        eff = role if role in ORG_WIDE_ROLES else effective_app_role(role, app_members.get(u.id))
        if eff is not None and Perm.CRM_WRITE in permissions_for(eff) and getattr(u, "status", "active") != "suspended":
            out[u.id] = u
    return out


def check_owner(db: Session, ctx, user_id: str | None) -> str | None:
    if user_id is None:
        return None
    if user_id not in team(db, ctx.organization_id, ctx.application_id):
        raise ValidationFailed("That person can't own CRM records in this application", code="INVALID_OWNER")
    return user_id


def user_ref(u: User | None) -> dict | None:
    return {"id": u.id, "full_name": u.full_name, "email": u.email} if u else None


def users_by_id(db: Session, ids) -> dict[str, User]:
    ids = {i for i in ids if i}
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


# ------------------------------------------------------------------ lookups

def get_in_app(db: Session, ctx, model, obj_id: str | None, what: str):
    obj = db.get(model, obj_id) if obj_id else None
    if obj is None or obj.application_id != ctx.application_id:
        raise NotFound(f"{what} not found")
    return obj


def optional_in_app(db: Session, ctx, model, obj_id: str | None, what: str):
    return get_in_app(db, ctx, model, obj_id, what) if obj_id else None


def contact_name(c: Contact) -> str:
    return c.full_name or c.email or c.phone or "Unnamed contact"


def reach(c: Contact) -> dict[str, bool]:
    """Quick per-channel reachability: an address, consent, not unsubscribed and not blocked/bounced.
    Suppression lists and regional rules are re-checked at send time."""
    blocked = c.status == "blocked"
    return {"email": bool(c.email and c.email_consent and c.email_unsubscribed_at is None and not blocked
                          and c.status != "bounced"),
            "sms": bool(c.phone and c.sms_consent and c.sms_unsubscribed_at is None and not blocked
                        and c.phone_type != "landline"),
            "voice": bool(c.phone and c.voice_consent and c.voice_unsubscribed_at is None and not blocked)}


def contact_ref(c: Contact | None, role: str | None = None) -> dict | None:
    if c is None:
        return None
    return {"id": c.id, "name": contact_name(c), "email": c.email, "phone": c.phone, "role": role,
            "reach": reach(c)}


# ------------------------------------------------------------------ defaults

def settings_for(db: Session, organization_id: str, application_id: str) -> CrmSettings:
    s = db.get(CrmSettings, application_id)
    if s is None:
        s = CrmSettings(application_id=application_id, organization_id=organization_id, engagement_window_days=30,
                        hot_score_threshold=50, sla_enabled=False, sla_minutes=60, assignment_cursor=utcnow())
        db.add(s)
        db.flush()
    return s


def ensure_defaults(db: Session, ctx) -> None:
    """Give a new application a sales pipeline and lost reasons the first time the CRM is used."""
    settings_for(db, ctx.organization_id, ctx.application_id)
    if db.scalar(select(Pipeline.id).where(Pipeline.application_id == ctx.application_id).limit(1)) is None:
        p = Pipeline(organization_id=ctx.organization_id, application_id=ctx.application_id, name="Sales pipeline",
                     currency=currency_for(ctx), is_default=True, position=0)
        db.add(p)
        db.flush()
        for i, (name, prob, kind, rot) in enumerate(DEFAULT_STAGES):
            db.add(PipelineStage(pipeline_id=p.id, application_id=ctx.application_id, name=name, position=i,
                                 probability=prob, kind=kind, rotting_days=rot))
    if db.scalar(select(LostReason.id).where(LostReason.application_id == ctx.application_id).limit(1)) is None:
        for i, name in enumerate(DEFAULT_LOST_REASONS):
            db.add(LostReason(organization_id=ctx.organization_id, application_id=ctx.application_id, name=name,
                              position=i))
    db.flush()


# ------------------------------------------------------------------ events and touches

def record_event(db: Session, organization_id: str, application_id: str, kind: str, *, contact_id: str | None = None,
                 deal_id: str | None = None, data: dict | None = None) -> None:
    db.add(CrmEvent(organization_id=organization_id, application_id=application_id, kind=kind,
                    contact_id=contact_id, deal_id=deal_id, data=data or {}))


def system_activity(db: Session, organization_id: str, application_id: str, subject: str, *,
                    actor_id: str | None = None, contact_id: str | None = None, deal_id: str | None = None,
                    company_id: str | None = None, meta: dict | None = None) -> None:
    db.add(CrmActivity(organization_id=organization_id, application_id=application_id, type="system",
                       subject=subject[:200], actor_user_id=actor_id, contact_id=contact_id, deal_id=deal_id,
                       company_id=company_id, meta=meta or {}, occurred_at=utcnow()))


def touched(db: Session, *, contact: Contact | None = None, deal: Deal | None = None,
            at: datetime | None = None) -> None:
    """A person worked this record: it counts as the first response, and the deal stops rotting."""
    at = at or utcnow()
    if contact is not None and contact.first_response_at is None:
        contact.first_response_at = at
    if deal is not None:
        deal.last_activity_at = at
        deal.rotting_since = None
    if contact is not None:
        contact.last_activity_at = max(contact.last_activity_at or at, at)


def sla_deadline(db: Session, contact: Contact) -> datetime | None:
    s = settings_for(db, contact.organization_id, contact.application_id)
    return (contact.created_at or utcnow()) + timedelta(minutes=s.sla_minutes) if s.sla_enabled else None


def company_of(db: Session, ctx, company_id: str | None) -> Company | None:
    return optional_in_app(db, ctx, Company, company_id, "Company")


class SystemContext:
    """Acts for the platform in background jobs and automation: every CRM permission, no user."""

    def __init__(self, organization_id: str, application_id: str, application=None):
        self.organization_id, self.application_id = organization_id, application_id
        self.application, self.user = application, None

    def require(self, *_perms) -> None:
        return None

    def has(self, *_perms) -> bool:
        return True


def system_ctx(db: Session, organization_id: str, application_id: str) -> SystemContext:
    from app.models import Application

    return SystemContext(organization_id, application_id, db.get(Application, application_id))

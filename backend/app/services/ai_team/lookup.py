"""Finding the records a tool call refers to: by id, or by a name the person typed ("Priya", "the Acme deal").
Every lookup is scoped to the caller's application."""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models import Contact, Deal, PipelineStage, User
from app.services.ai_team.registry import ToolError


def contact_name(c: Contact) -> str:
    return c.full_name or c.email or c.phone or "Contact"


def find_contacts(db: Session, ctx, query: str, limit: int = 5) -> list[Contact]:
    term = f"%{query.strip().lower()}%"
    name = func.lower(func.concat(func.coalesce(Contact.first_name, ""), " ", func.coalesce(Contact.last_name, "")))
    return list(db.scalars(select(Contact).where(
        Contact.application_id == ctx.application_id,
        or_(name.like(term), func.lower(func.coalesce(Contact.email, "")).like(term),
            func.coalesce(Contact.phone, "").like(term), func.lower(func.coalesce(Contact.company, "")).like(term)))
        .order_by(Contact.last_activity_at.desc()).limit(limit)))


def contact(db: Session, ctx, contact_id: str | None = None, query: str | None = None,
            required: bool = True) -> Contact | None:
    """One contact by id or by an unambiguous name/email. Several matches → ask the person to be specific."""
    if contact_id:
        c = db.get(Contact, contact_id)
        if c is None or c.application_id != ctx.application_id:
            raise ToolError("Contact not found", "NOT_FOUND")
        return c
    if query and query.strip():
        found = find_contacts(db, ctx, query)
        exact = [c for c in found if contact_name(c).lower() == query.strip().lower()]
        if len(found) == 1 or len(exact) == 1:
            return (exact or found)[0]
        if len(found) > 1:
            names = ", ".join(f"{contact_name(c)} ({c.email or c.phone or c.id[:8]})" for c in found[:5])
            raise ToolError(f"Several contacts match “{query}”: {names}. Which one?", "AMBIGUOUS")
        if required:
            raise ToolError(f"No contact matches “{query}”", "NOT_FOUND")
        return None
    if required:
        raise ToolError("Say which contact (a name, email or id)", "INVALID_ARGUMENTS")
    return None


def deal(db: Session, ctx, deal_id: str | None = None, query: str | None = None) -> Deal:
    if deal_id:
        d = db.get(Deal, deal_id)
        if d is None or d.application_id != ctx.application_id:
            raise ToolError("Deal not found", "NOT_FOUND")
        return d
    if query and query.strip():
        found = list(db.scalars(select(Deal).where(Deal.application_id == ctx.application_id,
                                                   Deal.title.ilike(f"%{query.strip()}%"))
                                .order_by(Deal.status == "open", Deal.updated_at.desc()).limit(5)))
        found.sort(key=lambda d: d.status != "open")
        if len(found) == 1 or (found and found[0].title.lower() == query.strip().lower()):
            return found[0]
        if found:
            raise ToolError("Several deals match: " + ", ".join(d.title for d in found) + ". Which one?", "AMBIGUOUS")
        raise ToolError(f"No deal matches “{query}”", "NOT_FOUND")
    raise ToolError("Say which deal", "INVALID_ARGUMENTS")


def stage(db: Session, ctx, pipeline_id: str, name_or_id: str) -> PipelineStage:
    stages = list(db.scalars(select(PipelineStage).where(PipelineStage.pipeline_id == pipeline_id,
                                                         PipelineStage.application_id == ctx.application_id)
                             .order_by(PipelineStage.position)))
    for s in stages:
        if s.id == name_or_id or s.name.lower() == name_or_id.strip().lower():
            return s
    for s in stages:
        if name_or_id.strip().lower() in s.name.lower():
            return s
    raise ToolError(f"No stage called “{name_or_id}”. Stages: {', '.join(s.name for s in stages)}", "NOT_FOUND")


def team_member(db: Session, ctx, who: str | None) -> str | None:
    """A teammate who can own CRM records, by id, email, name, or "me"."""
    from app.services.crm.common import team

    if not who:
        return None
    members = team(db, ctx.organization_id, ctx.application_id)
    if who == "me":
        return ctx.user.id if ctx.user and ctx.user.id in members else None
    if who in members:
        return who
    w = who.strip().lower()
    for uid, u in members.items():
        if u.email.lower() == w or u.full_name.lower() == w:
            return uid
    for uid, u in members.items():
        if w in u.full_name.lower():
            return uid
    raise ToolError(f"“{who}” can't own CRM records in this application", "NOT_FOUND")


def user_name(db: Session, uid: str | None) -> str:
    u = db.get(User, uid) if uid else None
    return u.full_name if u else "Unassigned"


def app_tz(ctx) -> ZoneInfo:
    try:
        return ZoneInfo((ctx.application.timezone if ctx.application else None) or "UTC")
    except Exception:  # noqa: BLE001 - an unknown zone falls back to UTC
        return ZoneInfo("UTC")


def due_time(ctx, due_at: str | None, due_in_days: int | None, hour: int = 10) -> datetime | None:
    """An ISO date/datetime, or N days from today at 10:00 in the application's timezone."""
    tz = app_tz(ctx)
    if due_at:
        try:
            dt = datetime.fromisoformat(due_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ToolError("Give the due date as YYYY-MM-DD or an ISO date-time", "INVALID_ARGUMENTS") from exc
        if len(due_at) <= 10:
            dt = datetime.combine(dt.date(), time(hour), tz)
        elif dt.tzinfo is None:
            dt = dt.replace(tzinfo=tz)
        return dt
    if due_in_days is not None:
        local = datetime.now(tz).date() + timedelta(days=due_in_days)
        return datetime.combine(local, time(hour), tz)
    return None


def fmt_time(ctx, dt: datetime | None) -> str:
    if dt is None:
        return "No due date"
    return dt.astimezone(app_tz(ctx)).strftime("%a %d %b %Y, %H:%M")

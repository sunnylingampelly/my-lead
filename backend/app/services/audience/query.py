"""Shared, tenant-scoped contact queries: filters, search, sorting and channel eligibility."""
from sqlalchemy import Select, and_, exists, func, not_, or_, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, ValidationFailed
from app.models import Contact, ContactListMember, ContactTag, Segment, SuppressionEntry
from app.schemas.audience import ContactFilters
from app.services.tenancy import AppContext

SORTABLE = {
    "created_at": Contact.created_at,
    "updated_at": Contact.updated_at,
    "first_name": Contact.first_name,
    "last_name": Contact.last_name,
    "email": Contact.email,
    "company": Contact.company,
    "city": Contact.city,
    "last_activity_at": Contact.last_activity_at,
    "lead_score": Contact.lead_score,
    "lifecycle_stage": Contact.lifecycle_stage,
}


def escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _not_suppressed(channel: str, hash_col):
    return not_(
        exists().where(
            SuppressionEntry.application_id == Contact.application_id,
            SuppressionEntry.channel == channel,
            SuppressionEntry.value_hash == hash_col,
        )
    )


def eligibility_condition(channel: str):
    """Contacts who may receive marketing on a channel: identifier present, consent given, not
    unsubscribed, not suppressed and not blocked or bounced. Regional rules (written consent in
    the US, DLT in India, quiet hours) are re-checked at send time."""
    if channel == "email":
        return and_(
            Contact.email.is_not(None),
            Contact.email_consent.is_(True),
            Contact.email_unsubscribed_at.is_(None),
            Contact.status.not_in(("bounced", "blocked")),
            _not_suppressed("email", Contact.email_hash),
        )
    if channel in ("sms", "voice"):
        consent = Contact.sms_consent if channel == "sms" else Contact.voice_consent
        unsub = Contact.sms_unsubscribed_at if channel == "sms" else Contact.voice_unsubscribed_at
        conds = [
            Contact.phone.is_not(None),
            consent.is_(True),
            unsub.is_(None),
            Contact.status != "blocked",
            _not_suppressed(channel, Contact.phone_hash),
        ]
        if channel == "sms":
            conds.append(or_(Contact.phone_type.is_(None), Contact.phone_type != "landline"))
        else:
            conds.append(Contact.dncr_registered.is_(False))  # UAE Do Not Call Registry: never called
        return and_(*conds)
    raise ValidationFailed(f"Unknown channel {channel}")


def base_query(ctx: AppContext) -> Select:
    return select(Contact).where(Contact.application_id == ctx.application_id)


def apply_filters(db: Session, ctx: AppContext, stmt: Select, f: ContactFilters | None) -> Select:
    if f is None:
        return stmt
    if f.search:
        term = f.search.strip()
        like = f"%{escape_like(term.lower())}%"
        digits = "".join(c for c in term if c.isdigit())
        conds = [
            func.lower(Contact.email).like(like, escape="\\"),
            func.lower(Contact.first_name).like(like, escape="\\"),
            func.lower(Contact.last_name).like(like, escape="\\"),
            func.lower(Contact.company).like(like, escape="\\"),
            func.lower(func.coalesce(Contact.first_name, "") + " " + func.coalesce(Contact.last_name, "")).like(
                like, escape="\\"),
        ]
        if len(digits) >= 4:
            conds.append(Contact.phone.like(f"%{digits}%"))
        stmt = stmt.where(or_(*conds))
    if f.status:
        stmt = stmt.where(Contact.status == f.status)
    if f.country:
        stmt = stmt.where(Contact.country == f.country.upper())
    if f.tag_id:
        stmt = stmt.where(exists().where(ContactTag.contact_id == Contact.id, ContactTag.tag_id == f.tag_id,
                                         ContactTag.application_id == ctx.application_id))
    if f.list_id:
        stmt = stmt.where(exists().where(ContactListMember.contact_id == Contact.id,
                                         ContactListMember.list_id == f.list_id,
                                         ContactListMember.application_id == ctx.application_id))
    if f.segment_id:
        from app.services.audience.segments import compile_rules

        seg = db.scalar(select(Segment).where(Segment.id == f.segment_id, Segment.application_id == ctx.application_id))
        if seg is None:
            raise NotFound("Segment not found")
        stmt = stmt.where(compile_rules(db, ctx, seg.rules))
    if f.eligible_for:
        stmt = stmt.where(eligibility_condition(f.eligible_for))
    if f.owner_id == "unassigned":
        stmt = stmt.where(Contact.owner_id.is_(None))
    elif f.owner_id:
        user = getattr(ctx, "user", None)
        stmt = stmt.where(Contact.owner_id == (user.id if f.owner_id == "me" and user else f.owner_id))
    if f.lifecycle_stage:
        stmt = stmt.where(Contact.lifecycle_stage == f.lifecycle_stage)
    if f.min_lead_score is not None:
        stmt = stmt.where(Contact.lead_score >= f.min_lead_score)
    return stmt


def apply_sort(stmt: Select, sort: str | None) -> Select:
    sort = sort or "-created_at"
    desc = sort.startswith("-")
    col = SORTABLE.get(sort.lstrip("-"))
    if col is None:
        raise ValidationFailed("Unsupported sort field", details={"allowed": sorted(SORTABLE)})
    return stmt.order_by(col.desc() if desc else col.asc(), Contact.id)


def count(db: Session, stmt: Select) -> int:
    sub = stmt.with_only_columns(Contact.id).order_by(None).subquery()
    return db.scalar(select(func.count()).select_from(sub)) or 0

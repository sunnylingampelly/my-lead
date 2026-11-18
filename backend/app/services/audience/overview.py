"""Audience overview metrics, computed from contact records."""
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import Perm
from app.models import Contact, Import
from app.services.audience.query import base_query, count, eligibility_condition
from app.services.tenancy import AppContext
from app.utils.time import utcnow


def growth(db: Session, ctx: AppContext, days: int = 30) -> list[dict]:
    """New contacts per day for the last N days (UTC dates), zero-filled."""
    since = (utcnow() - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    day = func.date(Contact.created_at)
    rows = dict(db.execute(select(day, func.count()).where(Contact.application_id == ctx.application_id,
                                                           Contact.created_at >= since).group_by(day)).all())
    total_before = db.scalar(select(func.count()).select_from(Contact).where(
        Contact.application_id == ctx.application_id, Contact.created_at < since)) or 0
    out, running = [], total_before
    for i in range(days):
        d = (since + timedelta(days=i)).date()
        n = rows.get(d.isoformat(), rows.get(d, 0)) or 0
        running += n
        out.append({"date": d.isoformat(), "new": int(n), "total": running})
    return out


def overview(db: Session, ctx: AppContext) -> dict:
    ctx.require(Perm.AUDIENCE_READ)
    q = base_query(ctx)
    total = count(db, q)
    by_status = dict(db.execute(select(Contact.status, func.count()).where(
        Contact.application_id == ctx.application_id).group_by(Contact.status)).all())
    reachable = {ch: count(db, q.where(eligibility_condition(ch))) for ch in ("email", "sms", "voice")}
    consent = {
        ch: db.scalar(select(func.count()).select_from(Contact).where(
            Contact.application_id == ctx.application_id, getattr(Contact, f"{ch}_consent").is_(True))) or 0
        for ch in ("email", "sms", "voice")
    }
    with_email = db.scalar(select(func.count()).select_from(Contact).where(
        Contact.application_id == ctx.application_id, Contact.email.is_not(None))) or 0
    with_phone = db.scalar(select(func.count()).select_from(Contact).where(
        Contact.application_id == ctx.application_id, Contact.phone.is_not(None))) or 0
    countries = db.execute(select(func.coalesce(Contact.phone_country, Contact.country), func.count())
                           .where(Contact.application_id == ctx.application_id)
                           .group_by(func.coalesce(Contact.phone_country, Contact.country))
                           .order_by(func.count().desc()).limit(6)).all()
    recent_imports = db.scalars(select(Import).where(Import.application_id == ctx.application_id)
                                .order_by(Import.created_at.desc()).limit(5)).all()
    new_7d = db.scalar(select(func.count()).select_from(Contact).where(
        Contact.application_id == ctx.application_id, Contact.created_at >= utcnow() - timedelta(days=7))) or 0
    return {
        "total": total,
        "active": by_status.get("active", 0),
        "unsubscribed": by_status.get("unsubscribed", 0),
        "bounced": by_status.get("bounced", 0),
        "blocked": by_status.get("blocked", 0),
        "new_last_7_days": new_7d,
        "with_email": with_email,
        "with_phone": with_phone,
        "consent": consent,
        "reachable": reachable,
        "countries": [{"country": c or "Unknown", "count": n} for c, n in countries],
        "growth": growth(db, ctx),
        "recent_imports": [
            {"id": i.id, "file_name": i.file_name, "status": i.status, "total_rows": i.total_rows,
             "created_count": i.created_count, "updated_count": i.updated_count, "created_at": i.created_at}
            for i in recent_imports
        ],
    }

"""Lead form submissions (list, spam, GDPR delete, CSV export) and analytics."""
import csv
import io
from collections import Counter
from collections.abc import Iterator
from datetime import date, datetime, time, timedelta
from urllib.parse import urlparse

from sqlalchemy import Text, delete, func, or_, select, type_coerce
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.errors import NotFound
from app.core.permissions import Perm
from app.models import Contact
from app.models.forms import LeadFormDailyStat, LeadFormSubmission, LeadFormVersion
from app.schemas.common import Page, PageParams
from app.schemas.forms import AnalyticsOut, CountRow, DailyRow, SubmissionOut
from app.services.audience.contacts import _safe_cell
from app.services.forms.service import _audit, _pct, get_form
from app.utils.time import utcnow

STATUSES = ("new", "spam", "pending_confirmation", "confirmed")


def _labels(db: Session, form) -> dict[int, dict[str, str]]:
    """version -> {field id: label}; version 0 is the current draft."""
    out = {0: {f["id"]: f.get("label") or f["id"] for f in (form.draft or {}).get("fields", [])}}
    for v, d in db.execute(select(LeadFormVersion.version, LeadFormVersion.definition).where(
            LeadFormVersion.form_id == form.id)):
        out[v] = {f["id"]: f.get("label") or f["id"] for f in d.get("fields", [])}
    return out


def _out(s: LeadFormSubmission, labels: dict, contact: Contact | None) -> SubmissionOut:
    name = None
    if contact is not None:
        name = contact.full_name or contact.email or contact.phone
    return SubmissionOut(id=s.id, status=s.status, spam_reason=s.spam_reason, values=s.values or {},
                         labels=labels.get(s.form_version) or labels[0], contact_id=s.contact_id,
                         contact_name=name, deal_id=s.deal_id, page_url=s.page_url, referrer=s.referrer,
                         utm=s.utm or {}, country=s.country, created_at=s.created_at, confirmed_at=s.confirmed_at)


def _query(form_id: str, search: str | None, status: str | None, date_from: date | None, date_to: date | None):
    q = select(LeadFormSubmission).where(LeadFormSubmission.form_id == form_id)
    if status in STATUSES:
        q = q.where(LeadFormSubmission.status == status)
    if date_from:
        q = q.where(LeadFormSubmission.created_at >= datetime.combine(date_from, time.min))
    if date_to:
        q = q.where(LeadFormSubmission.created_at < datetime.combine(date_to + timedelta(days=1), time.min))
    if search and search.strip():
        term = f"%{search.strip().lower()[:100]}%"
        q = q.outerjoin(Contact, Contact.id == LeadFormSubmission.contact_id).where(or_(
            func.lower(type_coerce(LeadFormSubmission.values, Text)).like(term),
            func.lower(Contact.email).like(term), func.lower(Contact.first_name).like(term),
            func.lower(Contact.last_name).like(term)))
    return q


def list_submissions(db: Session, ctx, form_id: str, params: PageParams, search: str | None, status: str | None,
                     date_from: date | None, date_to: date | None) -> Page[SubmissionOut]:
    ctx.require(Perm.FORMS_READ)
    f = get_form(db, ctx, form_id)
    q = _query(f.id, search, status, date_from, date_to)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(LeadFormSubmission.created_at.desc()).offset(params.offset)
                           .limit(params.page_size)))
    contacts = {c.id: c for c in db.scalars(select(Contact).where(
        Contact.id.in_({s.contact_id for s in rows if s.contact_id})))} if rows else {}
    labels = _labels(db, f)
    return Page(items=[_out(s, labels, contacts.get(s.contact_id)) for s in rows], total=total, page=params.page,
                page_size=params.page_size)


def _submission(db: Session, ctx, form_id: str, sid: str) -> tuple:
    f = get_form(db, ctx, form_id)
    s = db.get(LeadFormSubmission, sid)
    if s is None or s.form_id != f.id:
        raise NotFound("Submission not found")
    return f, s


def set_spam(db: Session, ctx, form_id: str, sid: str, spam: bool) -> SubmissionOut:
    ctx.require(Perm.FORMS_WRITE)
    f, s = _submission(db, ctx, form_id, sid)
    if spam and s.status != "spam":
        s.status, s.spam_reason = "spam", "marked_by_user"
    elif not spam and s.status == "spam":
        s.status, s.spam_reason = ("confirmed" if s.confirmed_at else "new"), None
    contact = db.get(Contact, s.contact_id) if s.contact_id else None
    return _out(s, _labels(db, f), contact)


def delete_submission(db: Session, ctx, form_id: str, sid: str) -> None:
    ctx.require(Perm.FORMS_WRITE)
    f, s = _submission(db, ctx, form_id, sid)
    _audit(db, ctx, "lead_form.submission_deleted", f, f"Deleted a submission of {f.name}", {"submission_id": s.id})
    db.execute(delete(LeadFormSubmission).where(LeadFormSubmission.id == s.id))


BASE_COLUMNS = ["submitted_at", "status", "contact_id"]
TAIL_COLUMNS = ["page_url", "referrer", "utm_source", "utm_medium", "utm_campaign", "country"]


def _cell(v) -> str:
    if isinstance(v, list):
        v = "; ".join(str(x) for x in v)
    elif isinstance(v, bool):
        v = "yes" if v else "no"
    return _safe_cell(v)


def export_csv(ctx, form_id: str, search: str | None, status: str | None, date_from: date | None,
               date_to: date | None) -> Iterator[str]:
    """Stream with its own session (the request session closes before streaming ends)."""
    with SessionLocal() as db:
        f = get_form(db, ctx, form_id)
        labels = _labels(db, f)
        field_ids = [x["id"] for x in f.draft.get("fields", [])]
        for v in sorted(labels):
            field_ids += [k for k in labels[v] if k not in field_ids]
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(BASE_COLUMNS + [labels[0].get(k) or next((lv[k] for lv in labels.values() if k in lv), k)
                                   for k in field_ids] + TAIL_COLUMNS)
        yield "﻿" + buf.getvalue()
        q = _query(f.id, search, status, date_from, date_to).order_by(LeadFormSubmission.created_at,
                                                                         LeadFormSubmission.id)
        offset = 0
        while True:
            batch = list(db.scalars(q.offset(offset).limit(1000)))
            if not batch:
                break
            buf = io.StringIO()
            w = csv.writer(buf)
            for s in batch:
                vals, utm = s.values or {}, s.utm or {}
                w.writerow([_cell(s.created_at), _cell(s.status), _cell(s.contact_id)]
                           + [_cell(vals.get(k)) for k in field_ids]
                           + [_cell(x) for x in (s.page_url, s.referrer, utm.get("utm_source"), utm.get("utm_medium"),
                                                 utm.get("utm_campaign"), s.country)])
            yield buf.getvalue()
            offset += len(batch)


# ------------------------------------------------------------------ analytics

def _page(url: str | None) -> str | None:
    if not url:
        return None
    try:
        p = urlparse(url)
    except ValueError:
        return None
    return f"{p.netloc}{p.path or '/'}"[:300] if p.netloc else None


def _top(values, n: int = 10) -> list[CountRow]:
    return [CountRow(value=v, count=c) for v, c in Counter(v for v in values if v).most_common(n)]


def analytics(db: Session, ctx, form_id: str, days: int) -> AnalyticsOut:
    ctx.require(Perm.FORMS_READ)
    f = get_form(db, ctx, form_id)
    days = max(1, min(days, 365))
    today = utcnow().date()
    start = today - timedelta(days=days - 1)
    rows = {r.day: r for r in db.scalars(select(LeadFormDailyStat).where(LeadFormDailyStat.form_id == f.id,
                                                                         LeadFormDailyStat.day >= start))}
    daily = []
    for i in range(days):
        d = start + timedelta(days=i)
        r = rows.get(d)
        daily.append(DailyRow(date=d, views=r.views if r else 0, starts=r.starts if r else 0,
                              submissions=r.submissions if r else 0))
    views = sum(x.views for x in daily)
    starts = sum(x.starts for x in daily)
    subs = sum(x.submissions for x in daily)
    recent = db.execute(select(LeadFormSubmission.page_url, LeadFormSubmission.referrer, LeadFormSubmission.utm)
                        .where(LeadFormSubmission.form_id == f.id, LeadFormSubmission.status != "spam",
                               LeadFormSubmission.created_at >= datetime.combine(start, time.min))
                        .order_by(LeadFormSubmission.created_at.desc()).limit(5000)).all()
    return AnalyticsOut(
        days=days, views=views, starts=starts, submissions=subs, conversion=_pct(subs, views),
        start_rate=_pct(starts, views), completion_rate=_pct(subs, starts), daily=daily,
        top_pages=_top(_page(p) for p, _, _ in recent),
        top_referrers=_top((urlparse(r).netloc or None) if r else None for _, r, _ in recent),
        top_utm_sources=_top(str((u or {}).get("utm_source") or "")[:100] or None for _, _, u in recent))

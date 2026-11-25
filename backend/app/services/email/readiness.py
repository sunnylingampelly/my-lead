"""Building blocks shared by the email, SMS and voice pre-send checklists.

Every check is self-describing (see ReadinessCheck): it says which editor step fixes it, or which page
outside the editor does, so the UI never has to hard-code a key → page mapping.
"""
from collections import Counter
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.permissions import Perm
from app.models import ApplicationSettings, Contact
from app.schemas.email import ReadinessCheck
from app.utils.time import utcnow

SUPPORTED_COUNTRIES = ("IN", "AE", "US")
COUNTRY_NAME = {"IN": "India", "AE": "the UAE", "US": "the United States"}
DEFAULT_QUIET = ("21:00", "09:00")


def check(key: str, label: str, ok: bool, detail: str | None = None, *, step: str | None = None,
          action_url: str | None = None, action_label: str | None = None, pending: bool = False,
          meta: dict | None = None) -> ReadinessCheck:
    return ReadinessCheck(key=key, label=label, ok=ok, detail=None if ok else detail, step=None if ok else step,
                          action_url=None if ok else action_url, action_label=None if ok else action_label,
                          pending=pending and not ok, meta=meta)


def app_url(ctx, path: str = "") -> str:
    return f"/apps/{ctx.application_id}{path}"


def settings_row(db: Session, application_id: str) -> ApplicationSettings | None:
    return db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == application_id))


def quiet_hours(db: Session, application_id: str) -> tuple[str, str]:
    s = settings_row(db, application_id)
    return (s.quiet_hours_start, s.quiet_hours_end) if s else DEFAULT_QUIET


def effective_country(ctx, chosen: str | None) -> str | None:
    """The sender's country once one is chosen; before that, the application's home market."""
    if chosen:
        return chosen
    app = getattr(ctx, "application", None)
    country = getattr(app, "default_country", None)
    return country if country in SUPPORTED_COUNTRIES else None


def wallet_check(db: Session, ctx, amount, currency: str | None) -> ReadinessCheck:
    """Enough credit for the estimate; carries balance and estimate so the UI can show both."""
    from app.services.billing import wallet as wl

    cov = wl.coverage(db, ctx.organization_id, amount, currency)
    has = getattr(ctx, "has", None)
    can_top_up = bool(has and has(Perm.BILLING_MANAGE))
    detail = None
    if not cov["ok"]:
        detail = (f"Needs about {cov['currency']} {cov['need']:,.2f}; {cov['currency']} {cov['available']:,.2f} "
                  "is available. " + ("Add credit to the wallet to continue." if can_top_up else
                                      "Add credit: ask an organization owner or admin to top up."))
    url = f"/orgs/{ctx.organization_id}/billing" if can_top_up else app_url(ctx, "/billing")
    return check("wallet", "Enough credit", cov["ok"], detail, action_url=url,
                 action_label="Top up" if can_top_up else "View billing",
                 meta={"available": cov["available"], "need": cov["need"], "currency": cov["currency"],
                       "estimate": round(float(amount or 0), 2), "estimate_currency": currency or cov["currency"],
                       "can_top_up": can_top_up})


def safe_commit(db: Session, what: str = "this change") -> None:
    """Commit, turning database rejections of a payload (too long, invalid JSON, bad value) into a 422
    with a readable message instead of a 500."""
    from sqlalchemy.exc import DataError, IntegrityError, OperationalError

    from app.core.errors import ValidationFailed

    try:
        db.commit()
    except (DataError, IntegrityError, OperationalError) as exc:
        db.rollback()
        reason = str(getattr(exc, "orig", exc)).split("\n")[0][:200]
        raise ValidationFailed(f"We couldn't save {what}: the database rejected it ({reason}). "
                               "Your other changes are not affected; try again.", code="SAVE_REJECTED") from exc


def wallet_info(db: Session, organization_id: str) -> dict:
    """Balance for review steps (shown next to the cost estimate)."""
    from app.services.billing import wallet as wl

    w = wl.get_wallet(db, organization_id)
    return {"available": float(wl.available(db, w)), "currency": w.currency}


def _hm(v: str) -> int:
    h, m = v.split(":")
    return int(h) * 60 + int(m)


def _fmt(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def effective_window(legal: tuple[str, str] | None, quiet: tuple[str, str]) -> dict:
    """The hours messages may go out: the legal window (if any) narrowed by the app's quiet hours.

    Quiet hours normally cross midnight (21:00 → 09:00) so the allowed part is quiet_end → quiet_start.
    """
    q_start, q_end = _hm(quiet[0]), _hm(quiet[1])
    allowed = (q_end, q_start) if q_start > q_end else None  # same-day quiet hours: no simple window
    if legal:
        l_start, l_end = _hm(legal[0]), _hm(legal[1])
        if allowed:
            start, end = max(l_start, allowed[0]), min(l_end, allowed[1])
            narrowed = (start, end) != (l_start, l_end)
        else:
            start, end, narrowed = l_start, l_end, False
        reason = "Legal calling window" + (", narrowed by your quiet hours" if narrowed else "")
        if end <= start:
            start, end, reason = l_start, l_end, "Legal calling window (your quiet hours leave no time inside it)"
    elif allowed:
        start, end = allowed
        reason = "Outside your quiet hours"
    else:
        return {"start": None, "end": None, "reason": f"Quiet hours {quiet[0]}–{quiet[1]} apply",
                "legal": None, "quiet": list(quiet)}
    return {"start": _fmt(start), "end": _fmt(end), "reason": reason, "legal": list(legal) if legal else None,
            "quiet": list(quiet)}


def waiting_estimate(db: Session, eligible_q, app_tz: str | None, resume_at, now: datetime | None = None
                     ) -> dict | None:
    """If sending now, how many eligible recipients would wait, and until when.

    `resume_at(now, tz)` returns None when a recipient in `tz` may be contacted now, else the UTC time
    they may be. Grouped by recipient time zone (falling back to the application's)."""
    now = now or utcnow()
    tz_col = func.coalesce(Contact.timezone, app_tz or "UTC")
    rows = db.execute(eligible_q.with_only_columns(tz_col, func.count()).group_by(tz_col).order_by(None)).all()
    waiting, earliest, earliest_tz, by_tz = 0, None, None, Counter()
    for tz, n in rows:
        at = resume_at(now, tz)
        if at is None:
            continue
        waiting += n
        by_tz[tz] += n
        if earliest is None or at < earliest:
            earliest, earliest_tz = at, tz
    if not waiting:
        return None
    main_tz = by_tz.most_common(1)[0][0]
    return {"waiting": waiting, "next_window_at": earliest.isoformat(), "timezone": earliest_tz or main_tz}

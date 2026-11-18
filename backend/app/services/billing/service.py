"""Wallet views and actions for organization owners and application managers."""
import csv
import io
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.models import Application
from app.models.billing import WalletHold, WalletTransaction
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.billing import wallet as wl
from app.utils.time import utcnow


def _app_filter(application_id: str | None):
    return [WalletTransaction.application_id == application_id] if application_id else []


def summary(db: Session, ctx, application_id: str | None = None) -> dict:
    ctx.require(Perm.BILLING_READ)
    w = wl.get_wallet(db, ctx.organization_id)
    db.commit()  # persist a newly created wallet (and its trial credit)
    now = utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    by_channel = {ch: float(-(v or 0)) for ch, v in db.execute(
        select(WalletTransaction.channel, func.sum(WalletTransaction.amount)).where(
            WalletTransaction.wallet_id == w.id, WalletTransaction.type == "usage",
            WalletTransaction.created_at >= month_start, *_app_filter(application_id))
        .group_by(WalletTransaction.channel))}
    since = (now - timedelta(days=29)).replace(hour=0, minute=0, second=0, microsecond=0)
    daily: dict[str, float] = {}
    for at, amount in db.execute(select(WalletTransaction.created_at, WalletTransaction.amount).where(
            WalletTransaction.wallet_id == w.id, WalletTransaction.type == "usage",
            WalletTransaction.created_at >= since, *_app_filter(application_id))):
        k = at.date().isoformat()
        daily[k] = round(daily.get(k, 0) - float(amount), 4)
    days = [(since + timedelta(days=i)).date().isoformat() for i in range(30)]
    holds = list(db.scalars(select(WalletHold).where(WalletHold.wallet_id == w.id, WalletHold.status == "open")
                            .order_by(WalletHold.created_at.desc())))
    app_names = dict(db.execute(select(Application.id, Application.name).where(
        Application.organization_id == ctx.organization_id)).all())
    per_app = [{"application_id": a, "application": app_names.get(a, "Deleted application"), "spend": float(-(v or 0))}
               for a, v in db.execute(select(WalletTransaction.application_id, func.sum(WalletTransaction.amount)).where(
                   WalletTransaction.wallet_id == w.id, WalletTransaction.type == "usage",
                   WalletTransaction.created_at >= month_start).group_by(WalletTransaction.application_id))]
    return {
        "currency": w.currency,
        "balance": float(wl.dec(w.balance)),
        "held": float(wl.held(db, w)),
        "available": float(wl.available(db, w)),
        "low_balance_threshold": float(w.low_balance_threshold),
        "low": wl.dec(w.balance) < wl.dec(w.low_balance_threshold),
        "month_usage": {"total": round(sum(by_channel.values()), 2), "by_channel": by_channel},
        "daily_usage": [{"date": d, "amount": daily.get(d, 0)} for d in days],
        "per_application": sorted(per_app, key=lambda x: -x["spend"]),
        "holds": [{"id": h.id, "description": h.description, "amount": float(h.amount),
                   "created_at": h.created_at.isoformat(), "application_id": h.application_id} for h in holds],
        "pricing": pricing(w.currency),
        "test_mode": settings.COMMUNICATION_MODE != "live",
        "can_manage": ctx.has(Perm.BILLING_MANAGE),
    }


def pricing(wallet_currency: str) -> list[dict]:
    """Platform prices shown in the wallet currency, so people can see what each channel costs."""
    rows = []
    for country in ("IN", "US"):
        e = settings.EMAIL_PRICING[country]
        s = settings.SMS_PRICING[country]
        v = settings.VOICE_PRICING[country]
        rows.append({"country": country,
                     "email": float(wl.convert(e["per_email"], e["currency"], wallet_currency)),
                     "sms_promotional": float(wl.convert(s["promotional"], s["currency"], wallet_currency)),
                     "sms_transactional": float(wl.convert(s["transactional"], s["currency"], wallet_currency)),
                     "voice_minute": float(wl.convert(v["per_minute"], v["currency"], wallet_currency))})
    return rows


def transactions(db: Session, ctx, params: PageParams, type_: str | None, application_id: str | None) -> Page:
    ctx.require(Perm.BILLING_READ)
    w = wl.get_wallet(db, ctx.organization_id)
    q = select(WalletTransaction).where(WalletTransaction.wallet_id == w.id, *_app_filter(application_id))
    if type_:
        q = q.where(WalletTransaction.type == type_)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(WalletTransaction.created_at.desc(), WalletTransaction.id)
                      .offset(params.offset).limit(params.page_size))
    return Page(items=[_tx(t) for t in rows], total=total, page=params.page, page_size=params.page_size)


def _tx(t: WalletTransaction) -> dict:
    return {"id": t.id, "type": t.type, "channel": t.channel, "amount": float(t.amount),
            "balance_after": float(t.balance_after), "description": t.description,
            "application_id": t.application_id, "reference_type": t.reference_type, "reference_id": t.reference_id,
            "meta": t.meta, "created_at": t.created_at.isoformat()}


def export_csv(db: Session, ctx, application_id: str | None) -> str:
    ctx.require(Perm.BILLING_READ)
    w = wl.get_wallet(db, ctx.organization_id)
    out = io.StringIO()
    wr = csv.writer(out)
    wr.writerow(["date_utc", "type", "channel", "description", f"amount_{w.currency}", f"balance_after_{w.currency}",
                 "units", "original_amount", "original_currency", "reference"])
    for t in db.scalars(select(WalletTransaction).where(WalletTransaction.wallet_id == w.id, *_app_filter(application_id))
                        .order_by(WalletTransaction.created_at)):
        m = t.meta or {}
        desc = t.description
        if desc[:1] in ("=", "+", "-", "@"):
            desc = "'" + desc  # spreadsheet formula injection
        wr.writerow([t.created_at.isoformat(timespec="seconds"), t.type, t.channel or "", desc, f"{t.amount:.4f}",
                     f"{t.balance_after:.4f}", m.get("units", ""), m.get("original_amount", ""),
                     m.get("original_currency", ""), t.reference_id or ""])
    return out.getvalue()


def add_test_credit(db: Session, ctx, amount: Decimal, idempotency_key: str) -> dict:
    """Simulation mode only: credit that is clearly marked as test money."""
    ctx.require(Perm.BILLING_MANAGE)
    if settings.COMMUNICATION_MODE == "live":
        raise ValidationFailed("Test credit is only available in simulation mode", code="LIVE_MODE")
    w = wl.get_wallet(db, ctx.organization_id)
    cap = Decimal(str(settings.TEST_TOPUP_MAX.get(w.currency, 0)))
    if amount <= 0 or amount > cap:
        raise ValidationFailed(f"Add between 1 and {cap:,.0f} {w.currency}", code="INVALID_AMOUNT")
    tx = wl.post(db, w, "test_credit", amount, description="Test credit (simulation mode, not real money)",
                 idempotency_key=f"topup:{idempotency_key}", actor_id=ctx.user.id)
    audit_service.record(db, "billing.test_credit", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         target_type="wallet", target_id=w.id, meta={"amount": float(amount), "currency": w.currency})
    return {"added": tx is not None, "balance": float(wl.dec(w.balance))}


def set_threshold(db: Session, ctx, amount: Decimal) -> None:
    ctx.require(Perm.BILLING_MANAGE)
    if amount < 0:
        raise ValidationFailed("The threshold cannot be negative")
    w = wl.get_wallet(db, ctx.organization_id)
    w.low_balance_threshold = amount
    w.low_balance_notified_at = None

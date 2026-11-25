"""Plan subscriptions, paid from the prepaid wallet.

* Organizations without a row are on Starter (free).
* Upgrading to Pro debits the full month from the wallet at once (ledger type "subscription",
  idempotency key sub:{org}:{period_start}) and starts a one-month period. It fails with
  INSUFFICIENT_BALANCE when the available balance cannot cover it.
* Switching to Starter is scheduled for the end of the paid period and can be undone until then.
* renew_due() runs periodically: at period end it charges the next month. If the wallet cannot cover
  it the subscription becomes past_due (owners and admins are notified) and the charge is retried on
  every run. After plans.GRACE_DAYS past due the organization moves to Starter.
* charge_recurring() is a generic monthly-fee helper (ledger type "recurring", idempotent on its key,
  returns False instead of raising when the balance is short). Nothing uses it today: phone numbers are
  managed by Signalcraft and never rented to customers.
"""
import calendar
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models.billing import Subscription, WalletTransaction
from app.services import audit_service
from app.services.billing import plans
from app.services.billing import wallet as wl
from app.utils.time import utcnow

log = get_logger(__name__)


def get(db: Session, organization_id: str, lock: bool = False) -> Subscription | None:
    q = select(Subscription).where(Subscription.organization_id == organization_id)
    if lock:
        q = q.with_for_update()
    return db.scalar(q)


def _get_or_create(db: Session, organization_id: str) -> Subscription:
    sub = get(db, organization_id, lock=True)
    if sub is not None:
        return sub
    sub = Subscription(organization_id=organization_id, plan=plans.STARTER, status="active",
                       cancel_at_period_end=False)
    sp = db.begin_nested()
    try:
        db.add(sub)
        sp.commit()
    except IntegrityError:
        sp.rollback()
        return get(db, organization_id, lock=True)
    return sub


def add_month(dt: datetime) -> datetime:
    """Same day next month, clamped to the month's last day (31 Jan -> 28/29 Feb)."""
    y, m = (dt.year + 1, 1) if dt.month == 12 else (dt.year, dt.month + 1)
    return dt.replace(year=y, month=m, day=min(dt.day, calendar.monthrange(y, m)[1]))


def _key(organization_id: str, period_start: datetime) -> str:
    return f"sub:{organization_id}:{period_start.replace(microsecond=0).isoformat()}"


def _charge_period(db: Session, sub: Subscription, period_start: datetime, actor_id: str | None = None
                   ) -> bool:
    """Debit one Pro month starting at period_start. False if the available balance is too low."""
    w = wl.get_wallet(db, sub.organization_id, lock=True)
    price = wl.dec(plans.plan_price(plans.PRO, w.currency))
    key = _key(sub.organization_id, period_start)
    already = db.scalar(select(WalletTransaction.id).where(WalletTransaction.wallet_id == w.id,
                                                           WalletTransaction.idempotency_key == key))
    if not already:
        if wl.available(db, w) < price:
            return False
        end = add_month(period_start)
        wl.post(db, w, "subscription", -price, idempotency_key=key, actor_id=actor_id,
                description=f"Pro plan, {period_start:%d %b %Y} to {end:%d %b %Y}",
                reference_type="subscription", reference_id=sub.id,
                meta={"plan": plans.PRO, "period_start": period_start.isoformat(), "period_end": end.isoformat()})
    sub.plan, sub.status, sub.past_due_since = plans.PRO, "active", None
    sub.current_period_start, sub.current_period_end = period_start, add_month(period_start)
    return True


def _to_starter(sub: Subscription) -> None:
    sub.plan, sub.status = plans.STARTER, "active"
    sub.current_period_start = sub.current_period_end = None
    sub.scheduled_plan, sub.cancel_at_period_end, sub.past_due_since = None, False, None


def _notify_admins(db: Session, organization_id: str, *, type_: str, level: str, title: str, body: str) -> None:
    from app.models import OrganizationMember
    from app.services.notification_service import notify

    for uid in db.scalars(select(OrganizationMember.user_id).where(
            OrganizationMember.organization_id == organization_id,
            OrganizationMember.role_key.in_(("owner", "admin")))):
        notify(db, uid, type_=type_, level=level, title=title, body=body,
               link=f"/orgs/{organization_id}/billing", organization_id=organization_id)


# ------------------------------------------------------------------ changes by people


def change_plan(db: Session, ctx, plan: str) -> dict:
    ctx.require(Perm.BILLING_MANAGE)
    if plan not in plans.PLANS:
        raise ValidationFailed("Choose Starter or Pro", code="INVALID_PLAN")
    org_id = ctx.organization_id
    sub = _get_or_create(db, org_id)
    before = {"plan": sub.plan, "status": sub.status, "scheduled_plan": sub.scheduled_plan}
    action = None
    if plan == plans.PRO:
        if sub.plan == plans.PRO and sub.status == "active":
            if sub.scheduled_plan or sub.cancel_at_period_end:  # "stay on Pro" undoes a scheduled downgrade
                sub.scheduled_plan, sub.cancel_at_period_end = None, False
                action = "billing.plan_change_cancelled"
        else:
            # Starter -> Pro starts a new month now; a past-due Pro pays the overdue month.
            start = sub.current_period_end if sub.plan == plans.PRO and sub.current_period_end else utcnow()
            start = start.replace(microsecond=0)
            if not _charge_period(db, sub, start, actor_id=ctx.user.id):
                w = wl.get_wallet(db, org_id)
                price = plans.plan_price(plans.PRO, w.currency)
                raise ValidationFailed(
                    f"Pro costs {w.currency} {price:,.2f} a month, charged from your wallet now. "
                    f"{w.currency} {wl.available(db, w):,.2f} is available. Add credit to upgrade.",
                    code="INSUFFICIENT_BALANCE")
            sub.scheduled_plan, sub.cancel_at_period_end = None, False
            action = "billing.plan_upgraded"
    else:  # Starter
        if sub.plan == plans.PRO:
            if sub.status == "past_due":  # nothing paid for this period: switch now
                _to_starter(sub)
                action = "billing.plan_downgraded"
            elif sub.scheduled_plan != plans.STARTER:
                sub.scheduled_plan, sub.cancel_at_period_end = plans.STARTER, True
                action = "billing.plan_downgrade_scheduled"
    if action:
        audit_service.record(db, action, actor_user_id=ctx.user.id, organization_id=org_id,
                             target_type="subscription", target_id=sub.id,
                             summary=f"Plan change to {plans.PLANS[plan]['name']}",
                             meta={"before": before, "after": {"plan": sub.plan, "status": sub.status,
                                                               "scheduled_plan": sub.scheduled_plan}})
    db.flush()
    return overview(db, ctx)


def cancel_change(db: Session, ctx) -> dict:
    """Undo a scheduled downgrade."""
    ctx.require(Perm.BILLING_MANAGE)
    sub = get(db, ctx.organization_id, lock=True)
    if sub is not None and (sub.scheduled_plan or sub.cancel_at_period_end):
        scheduled = sub.scheduled_plan
        sub.scheduled_plan, sub.cancel_at_period_end = None, False
        audit_service.record(db, "billing.plan_change_cancelled", actor_user_id=ctx.user.id,
                             organization_id=ctx.organization_id, target_type="subscription", target_id=sub.id,
                             summary="Cancelled the scheduled plan change", meta={"scheduled_plan": scheduled})
        db.flush()
    return overview(db, ctx)


# ------------------------------------------------------------------ periodic job


def renew_due(db: Session, now: datetime | None = None) -> dict:
    """Renew, downgrade or expire every Pro subscription whose period has ended. Safe to re-run."""
    now = now or utcnow()
    out = {"renewed": 0, "downgraded": 0, "past_due": 0, "expired": 0}
    ids = list(db.scalars(select(Subscription.id).where(Subscription.plan == plans.PRO,
                                                        Subscription.current_period_end <= now)))
    for sid in ids:
        sub = db.scalar(select(Subscription).where(Subscription.id == sid).with_for_update())
        if sub is None or sub.plan != plans.PRO or sub.current_period_end is None or sub.current_period_end > now:
            continue
        org_id = sub.organization_id
        if sub.scheduled_plan == plans.STARTER or sub.cancel_at_period_end:
            _to_starter(sub)
            out["downgraded"] += 1
            audit_service.record(db, "billing.plan_downgraded", organization_id=org_id,
                                 target_type="subscription", target_id=sub.id,
                                 summary="Scheduled switch to Starter took effect")
            continue
        if _charge_period(db, sub, sub.current_period_end):
            out["renewed"] += 1
            continue
        w = wl.get_wallet(db, org_id)
        price = plans.plan_price(plans.PRO, w.currency)
        if sub.status != "past_due":
            sub.status, sub.past_due_since = "past_due", now
            out["past_due"] += 1
            _notify_admins(db, org_id, type_="plan_past_due", level="warning", title="Pro renewal failed",
                           body=f"Your wallet could not cover the {w.currency} {price:,.2f} Pro renewal. Add credit "
                                f"within {plans.GRACE_DAYS} days to stay on Pro.")
            audit_service.record(db, "billing.plan_past_due", organization_id=org_id,
                                 target_type="subscription", target_id=sub.id, summary="Pro renewal failed")
        elif sub.past_due_since and sub.past_due_since + timedelta(days=plans.GRACE_DAYS) <= now:
            _to_starter(sub)
            out["expired"] += 1
            _notify_admins(db, org_id, type_="plan_expired", level="error", title="Moved to the Starter plan",
                           body=f"The Pro renewal stayed unpaid for {plans.GRACE_DAYS} days, so this organization "
                                "is now on Starter. Upgrade again any time.")
            audit_service.record(db, "billing.plan_expired", organization_id=org_id,
                                 target_type="subscription", target_id=sub.id,
                                 summary=f"Moved to Starter after {plans.GRACE_DAYS} days past due")
    db.flush()
    return out


def run_renewals() -> dict:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        out = renew_due(db)
        db.commit()
    return out


# ------------------------------------------------------------------ recurring fees


def charge_recurring(db: Session, organization_id: str, *, key: str, amount, currency: str, description: str,
                     application_id: str | None = None, reference_type: str | None = None,
                     reference_id: str | None = None) -> bool:
    """Debit a recurring fee once per `key`.

    True if charged now or already charged under this key; False if the available balance is too low
    (nothing is debited). `amount` is in `currency` and converted to the wallet currency."""
    w = wl.get_wallet(db, organization_id, lock=True)
    idem = f"recurring:{key}"
    if db.scalar(select(WalletTransaction.id).where(WalletTransaction.wallet_id == w.id,
                                                    WalletTransaction.idempotency_key == idem)):
        return True
    amt = wl.convert(amount, currency, w.currency)
    if amt <= 0:
        return True
    if wl.available(db, w) < amt:
        return False
    meta = {"original_amount": float(wl.dec(amount)), "original_currency": currency} if currency != w.currency else {}
    wl.post(db, w, "recurring", -amt, description=description, idempotency_key=idem, application_id=application_id,
            reference_type=reference_type, reference_id=reference_id, meta=meta)
    return True


# ------------------------------------------------------------------ views


def recurring_last_month(db: Session, organization_id: str) -> Decimal:
    """What recurring fees cost over the last 30 days, in the wallet currency."""
    w = wl.get_wallet(db, organization_id)
    total = db.scalar(select(func.coalesce(func.sum(WalletTransaction.amount), 0)).where(
        WalletTransaction.wallet_id == w.id, WalletTransaction.type == "recurring",
        WalletTransaction.created_at >= utcnow() - timedelta(days=30)))
    return -wl.dec(total)


def _plan_card(p: dict, currency: str) -> dict:
    return {"key": p["key"], "name": p["name"], "tagline": p["tagline"],
            "price": float(plans.plan_price(p["key"], currency)), "currency": currency,
            "usage_discount": float(p["usage_discount"]),
            "limits": dict(p["limits"]), "features": list(p["features"])}


def brief(db: Session, organization_id: str) -> dict:
    """Small form for the billing summary / topbar badge."""
    p = plans.current_plan(db, organization_id)
    sub = get(db, organization_id)
    return {"key": p["key"], "name": p["name"], "status": p["status"],
            "scheduled_plan": sub.scheduled_plan if sub else None,
            "current_period_end": sub.current_period_end.isoformat() if sub and sub.current_period_end else None}


def overview(db: Session, ctx) -> dict:
    ctx.require(Perm.BILLING_READ)
    org_id = ctx.organization_id
    w = wl.get_wallet(db, org_id)
    p = plans.current_plan(db, org_id)
    sub = get(db, org_id)
    end = sub.current_period_end if sub else None
    renews = p["key"] == plans.PRO and not (sub and (sub.scheduled_plan or sub.cancel_at_period_end))
    plan_fee = wl.dec(plans.plan_price(plans.PRO, w.currency)) if renews else Decimal("0")
    grace_ends = (sub.past_due_since + timedelta(days=plans.GRACE_DAYS)
                  if sub and sub.status == "past_due" and sub.past_due_since else None)
    iso = lambda d: d.isoformat() if d else None  # noqa: E731
    return {
        "plan": p["key"],
        "name": p["name"],
        "status": p["status"],
        "currency": w.currency,
        "current_period_start": iso(sub.current_period_start if sub else None),
        "current_period_end": iso(end),
        "scheduled_plan": sub.scheduled_plan if sub else None,
        "scheduled_change_at": iso(end) if sub and sub.scheduled_plan else None,
        "past_due_since": iso(sub.past_due_since if sub else None),
        "grace_ends_at": iso(grace_ends),
        "usage_discount": float(p["usage_discount"]),
        "limits": dict(p["limits"]),
        "usage": plans.usage(db, org_id),
        "catalogue": [_plan_card(x, w.currency) for x in plans.PLANS.values()],
        # No renewal date once a switch to Starter is scheduled: Pro simply ends at the period end.
        "next_charge": {"date": iso(end) if renews else None, "plan": float(plan_fee), "total": float(plan_fee)},
        "recurring": {"plan": float(plan_fee), "total": float(plan_fee)},
        "available": float(wl.available(db, w)),
        "can_manage": ctx.has(Perm.BILLING_MANAGE),
    }

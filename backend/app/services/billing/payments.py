"""Wallet top-ups. The wallet is credited only from a verified provider webhook, never from the
browser redirect, and only for the amount and currency recorded when the checkout was created."""
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import NotFound, ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import Organization
from app.models.payment import Payment
from app.providers import payments as pp
from app.schemas.common import Page, PageParams
from app.services import audit_service
from app.services.billing import wallet as wl
from app.utils.time import utcnow

log = get_logger(__name__)
LIMITS = {"INR": (Decimal("100"), Decimal("500000")), "USD": (Decimal("5"), Decimal("10000"))}


def provider_for(currency: str) -> str | None:
    if currency == "INR" and settings.RAZORPAY_KEY_ID and settings.RAZORPAY_KEY_SECRET and settings.RAZORPAY_WEBHOOK_SECRET:
        return "razorpay"
    if currency == "USD" and settings.STRIPE_SECRET_KEY and settings.STRIPE_WEBHOOK_SECRET:
        return "stripe"
    return None


def availability(currency: str) -> dict:
    lo, hi = LIMITS[currency]
    return {"provider": provider_for(currency) if settings.COMMUNICATION_MODE == "live" else None,
            "min": float(lo), "max": float(hi)}


def create_checkout(db: Session, ctx, amount: Decimal) -> Payment:
    ctx.require(Perm.BILLING_MANAGE)
    w = wl.get_wallet(db, ctx.organization_id)
    if settings.COMMUNICATION_MODE != "live":
        raise ValidationFailed("Payments are turned off in simulation mode. Add test credit instead.",
                               code="SIMULATION_MODE")
    provider = provider_for(w.currency)
    if provider is None:
        raise ValidationFailed(f"Online payment in {w.currency} is not set up on this platform yet. "
                               "Contact support to add credit.", code="PAYMENTS_NOT_CONFIGURED")
    lo, hi = LIMITS[w.currency]
    if not lo <= amount <= hi:
        raise ValidationFailed(f"Add between {w.currency} {lo:,.0f} and {w.currency} {hi:,.0f}", code="INVALID_AMOUNT")
    org = db.get(Organization, ctx.organization_id)
    p = Payment(organization_id=org.id, provider=provider, amount=amount, currency=w.currency, status="pending",
                created_by_id=ctx.user.id, meta={})
    db.add(p)
    db.flush()
    back = f"{settings.FRONTEND_URL}/orgs/{org.id}/billing?payment={p.id}"
    try:
        if provider == "stripe":
            co = pp.stripe_checkout(settings.STRIPE_SECRET_KEY, amount=amount, currency=w.currency, payment_id=p.id,
                                    org_name=org.name, success_url=back, cancel_url=back, email=ctx.user.email)
        else:
            co = pp.razorpay_link(settings.RAZORPAY_KEY_ID, settings.RAZORPAY_KEY_SECRET, amount=amount,
                                  payment_id=p.id, org_name=org.name, callback_url=back, email=ctx.user.email)
    except pp.PaymentError as exc:
        p.status, p.failure_reason = "failed", str(exc)[:255]
        db.commit()
        raise ValidationFailed(f"The payment page could not be opened: {exc}", code="PAYMENT_PROVIDER_ERROR") from exc
    p.provider_ref, p.checkout_url = co.provider_ref, co.url
    audit_service.record(db, "billing.checkout_created", actor_user_id=ctx.user.id, organization_id=org.id,
                         target_type="payment", target_id=p.id, meta={"amount": float(amount), "currency": w.currency,
                                                                       "provider": provider})
    return p


def get_payment(db: Session, ctx, payment_id: str) -> dict:
    ctx.require(Perm.BILLING_READ)
    p = db.scalar(select(Payment).where(Payment.id == payment_id, Payment.organization_id == ctx.organization_id))
    if p is None:
        raise NotFound("Payment not found")
    return out(p)


def out(p: Payment) -> dict:
    return {"id": p.id, "provider": p.provider, "amount": float(p.amount), "currency": p.currency, "status": p.status,
            "paid_at": p.paid_at.isoformat() if p.paid_at else None, "failure_reason": p.failure_reason,
            "created_at": p.created_at.isoformat()}


def list_payments(db: Session, ctx, params: PageParams) -> Page:
    ctx.require(Perm.BILLING_READ)
    q = select(Payment).where(Payment.organization_id == ctx.organization_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(Payment.created_at.desc()).offset(params.offset).limit(params.page_size))
    return Page(items=[out(p) for p in rows], total=total, page=params.page, page_size=params.page_size)


def mark_paid(db: Session, payment_id: str | None, provider: str, provider_ref: str | None, paid_minor: int | None,
              currency: str | None, provider_payment_id: str | None) -> str:
    """Credit the wallet once for a verified successful payment. Returns what happened."""
    p = db.get(Payment, payment_id) if payment_id else None
    if p is None and provider_ref:
        p = db.scalar(select(Payment).where(Payment.provider == provider, Payment.provider_ref == provider_ref))
    if p is None or p.provider != provider:
        return "unknown_payment"
    if provider_ref and p.provider_ref and provider_ref != p.provider_ref:
        return "reference_mismatch"
    if paid_minor is not None and paid_minor != pp.minor_units(Decimal(str(p.amount))):
        p.status, p.failure_reason = "failed", "Paid amount did not match the checkout"
        log.warning("payment_amount_mismatch", payment_id=p.id)
        return "amount_mismatch"
    if currency and currency.upper() != p.currency:
        p.status, p.failure_reason = "failed", "Paid currency did not match the checkout"
        return "currency_mismatch"
    if p.status == "paid":
        return "already_paid"
    w = wl.get_wallet(db, p.organization_id)
    wl.post(db, w, "credit", Decimal(str(p.amount)), description=f"Payment via {provider.capitalize()}",
            idempotency_key=f"payment:{p.id}", reference_type="payment", reference_id=p.id,
            meta={"provider_payment_id": provider_payment_id, "provider_ref": p.provider_ref}, actor_id=p.created_by_id)
    p.status, p.paid_at = "paid", utcnow()
    p.meta = {**(p.meta or {}), "provider_payment_id": provider_payment_id}
    return "credited"


def mark_failed(db: Session, provider: str, provider_ref: str | None, payment_id: str | None, reason: str) -> str:
    p = db.get(Payment, payment_id) if payment_id else None
    if p is None and provider_ref:
        p = db.scalar(select(Payment).where(Payment.provider == provider, Payment.provider_ref == provider_ref))
    if p is None or p.status == "paid":
        return "ignored"
    p.status, p.failure_reason = ("expired" if "expire" in reason else "failed"), reason[:255]
    return p.status

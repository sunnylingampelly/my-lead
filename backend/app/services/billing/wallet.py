"""Organization wallets.

* The ledger is append-only. Every entry locks the wallet row, checks an idempotency key and
  updates the cached balance in the same transaction, so retries never double-charge.
* Launching a campaign places a hold for its estimated cost; it fails if the available balance
  (balance minus open holds) cannot cover it. Holds are released when the campaign ends.
* Usage is charged from the channel records themselves (accepted emails, SMS cost, call minutes) by
  settle_usage(), which charges only the difference since the last settlement. The plan's usage
  multiplier (Pro: 20% off) is applied to each campaign's cumulative total, so the difference stays correct.
* Ledger types: trial_credit | test_credit | credit | usage | adjustment | refund | subscription
  (plan fees) | recurring (monthly fees such as phone-number rental; see subscriptions.py).
* Amounts in another currency are converted with the platform's configured rate, recorded on the entry.
"""
from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import case, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import ValidationFailed
from app.core.logging import get_logger
from app.models import Organization
from app.models.billing import UsageSettlement, Wallet, WalletHold, WalletTransaction
from app.utils.time import utcnow

log = get_logger(__name__)
Q = Decimal("0.0001")


def dec(x) -> Decimal:
    return Decimal(str(x or 0)).quantize(Q, rounding=ROUND_HALF_UP)


def currency_for(country: str | None) -> str:
    return "INR" if country == "IN" else "USD"


def convert(amount, from_cur: str | None, to_cur: str) -> Decimal:
    """Platform conversion rate (settings.FX_RATES), e.g. {"USD_INR": 83.0}."""
    a = dec(amount)
    if not from_cur or from_cur == to_cur:
        return a
    rate = settings.FX_RATES.get(f"{from_cur}_{to_cur}")
    if rate is None:
        inverse = settings.FX_RATES.get(f"{to_cur}_{from_cur}")
        if not inverse:
            raise ValidationFailed(f"No conversion rate from {from_cur} to {to_cur}", code="NO_FX_RATE")
        rate = 1 / inverse
    return dec(a * Decimal(str(rate)))


def get_wallet(db: Session, organization_id: str, lock: bool = False) -> Wallet:
    q = select(Wallet).where(Wallet.organization_id == organization_id)
    if lock:
        q = q.with_for_update()
    w = db.scalar(q)
    if w is not None:
        return w
    org = db.get(Organization, organization_id)
    cur = currency_for(org.country if org else None)
    w = Wallet(organization_id=organization_id, currency=cur, balance=0,
               low_balance_threshold=settings.LOW_BALANCE_DEFAULT.get(cur, 0))
    sp = db.begin_nested()
    try:
        db.add(w)
        sp.commit()
    except IntegrityError:
        sp.rollback()
        return db.scalar(q)
    trial = settings.TRIAL_CREDIT.get(cur) if settings.COMMUNICATION_MODE != "live" else None
    if trial:
        post(db, w, "trial_credit", trial, description="Trial credit for simulation mode (not real money)",
             idempotency_key="trial")
    return w


def held(db: Session, w: Wallet) -> Decimal:
    return dec(db.scalar(select(func.coalesce(func.sum(WalletHold.amount), 0)).where(
        WalletHold.wallet_id == w.id, WalletHold.status == "open")))


def available(db: Session, w: Wallet) -> Decimal:
    return dec(w.balance) - held(db, w)


def post(db: Session, w: Wallet, type_: str, amount, *, description: str, idempotency_key: str,
         application_id: str | None = None, channel: str | None = None, reference_type: str | None = None,
         reference_id: str | None = None, meta: dict | None = None, actor_id: str | None = None
         ) -> WalletTransaction | None:
    """Append one ledger entry. Returns None if this idempotency key was already recorded."""
    if db.scalar(select(WalletTransaction.id).where(WalletTransaction.wallet_id == w.id,
                                                    WalletTransaction.idempotency_key == idempotency_key)):
        return None
    db.flush()  # earlier entries in this transaction must be written before the locked re-read
    db.refresh(w, with_for_update=True)
    amt = dec(amount)
    new_balance = dec(w.balance) + amt
    tx = WalletTransaction(wallet_id=w.id, organization_id=w.organization_id, application_id=application_id,
                           type=type_, channel=channel, amount=amt, balance_after=new_balance,
                           reference_type=reference_type, reference_id=reference_id, description=description[:255],
                           meta=meta or {}, idempotency_key=idempotency_key[:160], created_by_id=actor_id)
    sp = db.begin_nested()
    try:
        db.add(tx)
        sp.commit()
    except IntegrityError:
        sp.rollback()
        return None
    w.balance = new_balance
    if new_balance < dec(w.low_balance_threshold) and amt < 0:
        _low_balance(db, w)
    elif new_balance >= dec(w.low_balance_threshold):
        w.low_balance_notified_at = None
    return tx


def _low_balance(db: Session, w: Wallet) -> None:
    if w.low_balance_notified_at and w.low_balance_notified_at > utcnow() - timedelta(days=1):
        return
    from app.models import OrganizationMember
    from app.services.notification_service import notify

    w.low_balance_notified_at = utcnow()
    owners = db.scalars(select(OrganizationMember.user_id).where(
        OrganizationMember.organization_id == w.organization_id, OrganizationMember.role_key.in_(("owner", "admin"))))
    for uid in owners:
        notify(db, uid, type_="low_balance", level="warning", title="Wallet balance is low",
               body=f"{w.currency} {dec(w.balance):,.2f} left. Add credit to keep campaigns sending.",
               link=f"/orgs/{w.organization_id}/billing", organization_id=w.organization_id)


# ------------------------------------------------------------------ holds


def place_hold(db: Session, organization_id: str, application_id: str, reference_type: str, reference_id: str,
               amount, currency: str | None, description: str) -> WalletHold:
    w = get_wallet(db, organization_id, lock=True)
    existing = db.scalar(select(WalletHold).where(WalletHold.reference_type == reference_type,
                                                  WalletHold.reference_id == reference_id))
    if existing is not None:
        return existing
    need = dec(convert(amount, currency, w.currency) * _multiplier(db, organization_id))
    if available(db, w) < need:
        raise ValidationFailed(
            f"Not enough credit: this needs about {w.currency} {need:,.2f} and {w.currency} "
            f"{available(db, w):,.2f} is available. Add credit to continue.", code="INSUFFICIENT_BALANCE")
    h = WalletHold(wallet_id=w.id, application_id=application_id, reference_type=reference_type,
                   reference_id=reference_id, amount=need, description=description[:255], status="open")
    db.add(h)
    db.flush()
    return h


def release_hold(db: Session, reference_type: str, reference_id: str) -> None:
    h = db.scalar(select(WalletHold).where(WalletHold.reference_type == reference_type,
                                           WalletHold.reference_id == reference_id, WalletHold.status == "open"))
    if h is not None:
        h.status, h.released_at = "released", utcnow()


def can_spend(db: Session, organization_id: str) -> bool:
    w = get_wallet(db, organization_id)
    return available(db, w) > 0


def coverage(db: Session, organization_id: str, amount, currency: str | None) -> dict:
    """For readiness checks: does the available balance cover an estimate?"""
    w = get_wallet(db, organization_id)
    need = dec(convert(amount, currency, w.currency) * _multiplier(db, organization_id))
    avail = available(db, w)
    return {"ok": avail >= need, "need": float(need), "available": float(avail), "currency": w.currency}


# ------------------------------------------------------------------ usage


def email_price(country: str | None) -> tuple[Decimal, str]:
    t = settings.EMAIL_PRICING.get(country or "", settings.EMAIL_PRICING["default"])
    return dec(t["per_email"]), t["currency"]


def _usage_rows(db: Session):
    """(channel, campaign, total cost in campaign currency, currency, final?) for campaigns with usage."""
    from app.models import Application
    from app.models.email import EmailCampaign, EmailMessage
    from app.models.sms import SmsCampaign, SmsMessage
    from app.models.voice import VoiceCall, VoiceCampaign

    final_states = ("completed", "cancelled", "failed")
    open_settled = select(UsageSettlement.campaign_id).where(UsageSettlement.final.is_(True))
    # Email: accepted messages × the price for the application's market.
    for c, sent, country in db.execute(
            select(EmailCampaign, func.count(EmailMessage.id), Application.default_country)
            .join(EmailMessage, EmailMessage.campaign_id == EmailCampaign.id)
            .join(Application, Application.id == EmailCampaign.application_id)
            .where(EmailMessage.accepted_at.is_not(None), EmailCampaign.id.not_in(open_settled))
            .group_by(EmailCampaign.id, Application.default_country)):
        price, cur = email_price(country)
        yield "email", c, dec(price * sent), cur, c.status in final_states, sent
    for model, msg, cost_col, channel in ((SmsCampaign, SmsMessage, SmsMessage.cost, "sms"),
                                          (VoiceCampaign, VoiceCall, VoiceCall.cost, "voice")):
        for c, total, n in db.execute(
                select(model, func.coalesce(func.sum(cost_col), 0),
                       func.sum(case((cost_col > 0, 1), else_=0)))
                .join(msg, msg.campaign_id == model.id)
                .where(model.id.not_in(open_settled), model.launched_at.is_not(None))
                .group_by(model.id)):
            yield channel, c, dec(total), c.currency, c.status in final_states, int(n or 0)


def _multiplier(db: Session, organization_id: str) -> Decimal:
    from app.services.billing.plans import usage_multiplier

    return usage_multiplier(db, organization_id)


def settle_usage(db: Session) -> int:
    """Charge each campaign's usage not yet charged. Safe to run any number of times.

    The amount due is the campaign's cumulative cost × the organization's plan multiplier, and only
    the part above what was already charged is debited."""
    entries = 0
    multipliers: dict[str, Decimal] = {}
    for channel, c, total, cur, final, units in list(_usage_rows(db)):
        w = get_wallet(db, c.organization_id)
        s = db.scalar(select(UsageSettlement).where(UsageSettlement.channel == channel,
                                                    UsageSettlement.campaign_id == c.id))
        if s is None:
            s = UsageSettlement(wallet_id=w.id, channel=channel, campaign_id=c.id, charged=0, final=False)
            db.add(s)
            db.flush()
        if c.organization_id not in multipliers:
            multipliers[c.organization_id] = _multiplier(db, c.organization_id)
        mult = multipliers[c.organization_id]
        due = dec(convert(total, cur or w.currency, w.currency) * mult)
        delta = due - dec(s.charged)
        if delta > 0:
            label = {"email": "Email", "sms": "SMS", "voice": "Voice"}[channel]
            tx = post(db, w, "usage", -delta, description=f"{label} usage: {c.name}"[:255],
                      idempotency_key=f"usage:{channel}:{c.id}:{due}", application_id=c.application_id,
                      channel=channel, reference_type=f"{channel}_campaign", reference_id=c.id,
                      meta={"units": units, "original_amount": float(total), "original_currency": cur,
                            **({"plan_discount": float(1 - mult)} if mult != 1 else {})})
            if tx is not None:
                entries += 1
            s.charged = due
        if final:
            s.final = True
            release_hold(db, f"{channel}_campaign", c.id)
    db.flush()
    return entries


def release_finished_holds(db: Session) -> int:
    """Release holds for campaigns that ended, including those that never sent anything."""
    from app.models.email import EmailCampaign
    from app.models.sms import SmsCampaign
    from app.models.voice import VoiceCampaign

    models = {"email_campaign": EmailCampaign, "sms_campaign": SmsCampaign, "voice_campaign": VoiceCampaign}
    n = 0
    for h in list(db.scalars(select(WalletHold).where(WalletHold.status == "open"))):
        c = db.get(models.get(h.reference_type, EmailCampaign), h.reference_id)
        if c is None or c.status in ("completed", "cancelled", "failed", "draft"):
            h.status, h.released_at = "released", utcnow()
            n += 1
    return n


def run_settlement() -> dict:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        entries = settle_usage(db)
        released = release_finished_holds(db)
        db.commit()
    return {"entries": entries, "released": released}


def wallet_check(db: Session, organization_id: str, amount, currency: str | None):
    """Readiness item: does the available credit cover this estimate?"""
    from app.schemas.email import ReadinessCheck

    cov = coverage(db, organization_id, amount, currency)
    detail = None if cov["ok"] else (f"Needs about {cov['currency']} {cov['need']:,.2f}; {cov['currency']} "
                                     f"{cov['available']:,.2f} is available. Add credit in Billing.")
    return ReadinessCheck(key="wallet", label="Enough credit", ok=cov["ok"], detail=detail)


def hold_or_fail(db: Session, c, channel: str, amount, currency: str | None) -> str | None:
    """Place a launch hold; return an error message instead of raising."""
    try:
        place_hold(db, c.organization_id, c.application_id, f"{channel}_campaign", c.id, amount, currency,
                   f"{ {'email': 'Email', 'sms': 'SMS', 'voice': 'Voice'}[channel]} campaign: {c.name}")
        return None
    except ValidationFailed as exc:
        return exc.message

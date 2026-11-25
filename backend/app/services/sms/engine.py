"""Background SMS sending.

Guarantees (same as email):
* Recipients are materialised once into sms_messages, unique per (campaign, contact).
* A message is claimed (queued/deferred → sending) before the provider call. A message left in
  "sending" by a dead worker is marked failed, never re-sent: at-most-once avoids duplicate texts.
* Eligibility is re-checked at send time, including the recipient's country.
* Promotional messages respect quiet hours in the recipient's timezone (falling back to the
  application's). Messages inside the window are deferred to its end, not dropped.
* Transient provider errors retry with exponential backoff; permanent errors are never retried.
"""
import threading
import time
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Application, ApplicationSettings, Contact, SuppressionEntry, User
from app.models.base import new_uuid
from app.models.sms import SmsCampaign, SmsMessage, SmsTemplate
from app.providers.sms.base import OutboundSms, SmsProvider, TransientSmsError
from app.providers.sms.factory import provider_for
from app.providers.sms.simulation import simulated_outcome
from app.services.audience.import_processor import TaskContext
from app.services.audience.query import base_query, eligibility_condition
from app.services.email.campaigns import audience_condition
from app.services.notification_service import notify
from app.services.sms import events, rules
from app.services.sms.campaigns import estimate, message_shape, personalise, readiness, sender_of, stats_for
from app.services.sms.encoding import analyse
from app.services.sms.registration import dlt_row
from app.utils.contact_normalize import identifier_hash
from app.utils.time import utcnow

log = get_logger(__name__)
BATCH = 100
MAX_ATTEMPTS = 5
STALE_SENDING = timedelta(minutes=10)
PENDING = ("queued", "deferred")

_running: set[str] = set()
_running_lock = threading.Lock()


def _task_ctx(db: Session, c: SmsCampaign) -> TaskContext:
    return TaskContext(c.organization_id, c.application_id, db.get(Application, c.application_id),
                       db.get(User, c.created_by_id) if c.created_by_id else None)


def _fail(db: Session, c: SmsCampaign, reason: str) -> str:
    c.status, c.error = "failed", reason[:500]
    notify(db, c.created_by_id, type_="campaign_failed", level="error", title=f"SMS campaign failed: {c.name}",
           body=c.error, link=f"/apps/{c.application_id}/sms/campaigns/{c.id}", organization_id=c.organization_id,
           application_id=c.application_id)
    db.commit()
    return "failed"


def launch(campaign_id: str) -> str:
    """queued → materialise recipients → sending → send."""
    with SessionLocal() as db:
        c = db.scalar(select(SmsCampaign).where(SmsCampaign.id == campaign_id).with_for_update())
        if c is None or c.status not in ("queued", "sending"):
            return c.status if c else "missing"
        if c.status == "queued":
            ctx = _task_ctx(db, c)
            checks, _ = readiness(db, ctx, c)
            failing = [ch for ch in checks if not ch.ok]
            if failing:
                return _fail(db, c, "; ".join(f"{ch.label}: {ch.detail}" for ch in failing))
            sender = sender_of(db, c)
            est = estimate(db, ctx, c.audience or {}, sender.country)
            from app.services.billing import wallet as wl
            from app.services.sms.campaigns import cost_estimate

            seg = message_shape(c.body, country=sender.country, category=c.category, append_opt_out=c.append_opt_out)
            cost = cost_estimate(est.eligible, seg["segments"], sender.country, c.category)
            problem = wl.hold_or_fail(db, c, "sms", cost["total"], cost["currency"])
            if problem:
                return _fail(db, c, problem)
            existing = set(db.scalars(select(SmsMessage.contact_id).where(SmsMessage.campaign_id == c.id)))
            stmt = (base_query(ctx).where(audience_condition(db, ctx, c.audience or {}), eligibility_condition("sms"),
                                          Contact.phone_country == sender.country)
                    .with_only_columns(Contact.id, Contact.phone).order_by(Contact.id))
            rows, created = [], 0
            now = utcnow()
            for cid, phone in db.execute(stmt):
                if cid in existing:
                    continue
                rows.append({"id": new_uuid(), "organization_id": c.organization_id,
                             "application_id": c.application_id, "campaign_id": c.id, "contact_id": cid,
                             "to_phone": phone, "country": sender.country, "status": "queued", "attempts": 0,
                             "segments": 0, "created_at": now, "updated_at": now})
                if len(rows) >= 1000:
                    db.execute(SmsMessage.__table__.insert(), rows)
                    created, rows = created + len(rows), []
            if rows:
                db.execute(SmsMessage.__table__.insert(), rows)
                created += len(rows)
            _, pname = provider_for(sender.provider)
            reg = dlt_row(db, c.application_id)
            t = db.get(SmsTemplate, c.template_id) if c.template_id else None
            shape = message_shape(c.body, country=sender.country, category=c.category,
                                  append_opt_out=c.append_opt_out)
            unit, currency = rules.price(sender.country, c.category)
            c.recipient_count = len(existing) + created
            c.excluded = est.excluded
            c.provider = pname
            c.currency = currency
            c.estimated_cost = Decimal(str(round(c.recipient_count * shape["segments"] * unit, 4)))
            c.sender_snapshot = {
                "sender_id": sender.sender_id, "country": sender.country, "kind": sender.kind,
                "provider": sender.provider, "dlt_header_id": sender.dlt_header_id,
                "dlt_template_id": t.dlt_template_id if t else None,
                "principal_entity_id": reg.principal_entity_id if reg else None,
            }
            c.status, c.launched_at = "sending", utcnow()
            db.commit()
            log.info("sms_campaign_launched", campaign_id=c.id, recipients=c.recipient_count, provider=pname)
    return send(campaign_id)


def send(campaign_id: str, max_wait_seconds: float = 0) -> str:
    """Send due messages until done, paused or cancelled. Returns the campaign status, or
    'retry:<seconds>' when only future (deferred or backed-off) messages remain."""
    with _running_lock:
        if campaign_id in _running:
            return "already_running"
        _running.add(campaign_id)
    db = SessionLocal()
    try:
        c = db.get(SmsCampaign, campaign_id)
        if c is None or c.status != "sending":
            return c.status if c else "missing"
        db.execute(update(SmsMessage).where(
            SmsMessage.campaign_id == c.id, SmsMessage.status == "sending",
            SmsMessage.updated_at < utcnow() - STALE_SENDING,
        ).values(status="failed", error_code="interrupted", failed_at=utcnow(),
                 error_message="Sending was interrupted; not retried to avoid a duplicate text"))
        db.commit()
        snap = c.sender_snapshot or {}
        provider, pname = provider_for(snap.get("provider"))
        app = db.get(Application, c.application_id)
        app_settings = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == c.application_id))
        quiet = (app_settings.quiet_hours_start, app_settings.quiet_hours_end) if app_settings else ("21:00", "09:00")
        rate = settings.SMS_RATE_PER_SECOND if pname != "simulation" else 0

        while True:
            db.refresh(c)
            if c.status != "sending":
                return c.status
            now = utcnow()
            batch = list(db.scalars(select(SmsMessage).where(
                SmsMessage.campaign_id == c.id, SmsMessage.status.in_(PENDING),
                (SmsMessage.next_attempt_at.is_(None)) | (SmsMessage.next_attempt_at <= now),
            ).order_by(SmsMessage.created_at, SmsMessage.id).limit(BATCH)))
            if not batch:
                pending = db.scalar(select(SmsMessage.next_attempt_at).where(
                    SmsMessage.campaign_id == c.id, SmsMessage.status.in_(PENDING))
                    .order_by(SmsMessage.next_attempt_at).limit(1))
                if pending is None:
                    return _finish(db, c)
                wait = max(1.0, (pending - utcnow()).total_seconds())
                if wait <= max_wait_seconds:
                    time.sleep(wait)
                    continue
                return f"retry:{int(wait)}"
            ids = [m.id for m in batch]
            db.execute(update(SmsMessage).where(SmsMessage.id.in_(ids), SmsMessage.status.in_(PENDING))
                       .values(status="sending", updated_at=utcnow()))
            db.commit()
            batch = list(db.scalars(select(SmsMessage).where(SmsMessage.id.in_(ids), SmsMessage.status == "sending")))
            started = time.monotonic()
            _send_batch(db, c, app, quiet, batch, provider, pname)
            db.commit()
            if rate:
                min_duration = len(batch) / rate
                elapsed = time.monotonic() - started
                if elapsed < min_duration:
                    time.sleep(min_duration - elapsed)
    finally:
        db.close()
        with _running_lock:
            _running.discard(campaign_id)


def _ineligible(contact: Contact | None, m: SmsMessage, suppressed: set[str]) -> str | None:
    if contact is None:
        return "Contact was deleted"
    if contact.phone != m.to_phone:
        return "Contact's phone number changed"
    if contact.sms_unsubscribed_at is not None or not contact.sms_consent:
        return "Contact withdrew SMS consent"
    if identifier_hash(m.to_phone) in suppressed:
        return "Number is on the suppression list"
    if contact.status == "blocked":
        return "Contact is blocked"
    if contact.phone_type == "landline":
        return "Landline numbers cannot receive SMS"
    if contact.phone_country != m.country:
        return "Number is not in the sender's country"
    return None


def _send_batch(db: Session, c: SmsCampaign, app: Application, quiet: tuple[str, str], batch: list[SmsMessage],
                provider: SmsProvider, pname: str) -> None:
    snap = c.sender_snapshot or {}
    contacts = {x.id: x for x in db.scalars(select(Contact).where(
        Contact.id.in_([m.contact_id for m in batch if m.contact_id])))}
    suppressed = set(db.scalars(select(SuppressionEntry.value_hash).where(
        SuppressionEntry.application_id == c.application_id, SuppressionEntry.channel == "sms",
        SuppressionEntry.value_hash.in_({identifier_hash(m.to_phone) for m in batch}))))
    unit, _ = rules.price(snap.get("country"), c.category)
    for m in batch:
        contact = contacts.get(m.contact_id)
        reason = _ineligible(contact, m, suppressed)
        if reason:
            m.status, m.error_code, m.error_message = "skipped", "ineligible", reason
            continue
        if c.category == "promotional":
            resume_at = rules.quiet_until(utcnow(), contact.timezone or app.timezone, *quiet)
            if resume_at is not None:
                m.status, m.next_attempt_at, m.deferred_reason = "deferred", resume_at, "quiet_hours"
                continue
        text = rules.final_body(personalise(c.body or "", contact, country=m.country), country=m.country or "",
                                category=c.category, append_opt_out=c.append_opt_out)
        info = analyse(text)
        m.body, m.encoding, m.segments = text, info.encoding, info.segments
        m.attempts += 1
        m.provider = pname
        m.deferred_reason = None
        try:
            res = provider.send(OutboundSms(
                to=m.to_phone, sender_id=snap.get("sender_id", ""), body=text, category=c.category,
                unicode=info.encoding == "UCS-2", dlt_template_id=snap.get("dlt_template_id"),
                dlt_entity_id=snap.get("principal_entity_id"),
                country=snap.get("country") or "", idempotency_key=m.id))
        except TransientSmsError as exc:
            if m.attempts >= MAX_ATTEMPTS:
                m.status, m.error_code, m.error_message, m.failed_at = "failed", "retries_exhausted", str(exc)[:500], \
                    utcnow()
            else:
                m.status = "queued"
                m.next_attempt_at = utcnow() + timedelta(seconds=min(30 * 2 ** (m.attempts - 1), 1800))
                m.error_code, m.error_message = "transient", str(exc)[:500]
            continue
        except Exception as exc:  # noqa: BLE001 - never loop on an unexpected error
            log.exception("sms_send_error", message_id=m.id)
            m.status, m.error_code, m.error_message, m.failed_at = "failed", "internal_error", type(exc).__name__, \
                utcnow()
            continue
        if not res.accepted:
            events.apply(db, m, "failed", provider=pname, provider_event_id=f"{m.id}:failed",
                         error_code=res.error_code, error_message=res.error_message)
            continue
        m.provider_message_id = res.provider_message_id
        m.error_code = m.error_message = None
        m.next_attempt_at = None
        m.cost = Decimal(str(round(info.segments * unit, 4)))
        events.apply(db, m, "accepted", provider=pname, provider_event_id=f"{m.id}:accepted")
        if pname == "simulation":
            # Simulated delivery receipts, applied through the same path as real ones.
            if simulated_outcome(m.to_phone) == "undelivered":
                events.apply(db, m, "undelivered", provider=pname, provider_event_id=f"sim:{m.id}:undelivered",
                             error_code="30003", error_message="Handset unreachable (simulated)")
            else:
                events.apply(db, m, "delivered", provider=pname, provider_event_id=f"sim:{m.id}:delivered")


def _finish(db: Session, c: SmsCampaign) -> str:
    c.status, c.completed_at = "completed", utcnow()
    st = stats_for(db, [c.id]).get(c.id)
    if c.created_by_id and st is not None:
        problems = st.failed + st.undelivered
        notify(db, c.created_by_id, type_="campaign_sent", level="warning" if problems else "success",
               title=f"SMS campaign sent: {c.name}",
               body=f"{st.sent:,} texts sent" + (f", {problems:,} failed or undelivered" if problems else ""),
               link=f"/apps/{c.application_id}/sms/campaigns/{c.id}",
               organization_id=c.organization_id, application_id=c.application_id)
    db.commit()
    log.info("sms_campaign_completed", campaign_id=c.id)
    return "completed"


def dispatch_due() -> int:
    """Queue due scheduled campaigns and wake sending campaigns whose deferred messages are due."""
    from app.tasks.sms import continue_sms_campaign, launch_sms_campaign
    from app.workers.dispatch import dispatch

    now = utcnow()
    with SessionLocal() as db:
        due = list(db.scalars(select(SmsCampaign).where(SmsCampaign.status == "scheduled",
                                                        SmsCampaign.scheduled_at <= now).with_for_update()))
        for c in due:
            c.status = "queued"
        db.commit()
        launch_ids = [c.id for c in due]
        wake_ids = list(db.scalars(select(SmsMessage.campaign_id).distinct().join(
            SmsCampaign, SmsCampaign.id == SmsMessage.campaign_id).where(
            SmsCampaign.status == "sending", SmsMessage.status.in_(PENDING),
            (SmsMessage.next_attempt_at.is_(None)) | (SmsMessage.next_attempt_at <= now))))
    for i in launch_ids:
        dispatch(launch_sms_campaign, i)
    with _running_lock:
        wake_ids = [i for i in wake_ids if i not in _running]
    for i in wake_ids:
        dispatch(continue_sms_campaign, i)
    return len(launch_ids) + len(wake_ids)

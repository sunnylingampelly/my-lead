"""Background campaign sending.

Guarantees:
* Recipients are materialised once into email_messages, unique per (campaign, contact). Re-running a
  launch skips existing rows, so retries never add duplicates.
* A message is claimed (queued → sending) before the provider call. If a worker dies after claiming,
  the message is NOT re-sent (the outcome is unknown); it is marked failed with a clear reason.
  At-most-once is the safe default for marketing email.
* Eligibility is re-checked at send time: someone who unsubscribed after launch is skipped.
* Transient provider errors retry with exponential backoff; permanent errors are never retried.
"""
import time
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Application, ApplicationSettings, Contact, Organization, SuppressionEntry, User
from app.models.base import new_uuid
from app.models.email import EmailCampaign, EmailMessage, EmailSender
from app.providers.email.base import EmailProvider, OutboundEmail, TransientProviderError
from app.providers.email.simulation import SimulationEmailProvider
from app.services.audience.import_processor import TaskContext
from app.services.audience.query import base_query, eligibility_condition
from app.services.email import events, render
from app.services.email.campaigns import audience_condition, estimate, readiness
from app.services.notification_service import notify
from app.utils.contact_normalize import identifier_hash
from app.utils.time import utcnow

log = get_logger(__name__)
BATCH = 200
MAX_ATTEMPTS = 5
STALE_SENDING = timedelta(minutes=10)


def provider_for(app_settings: ApplicationSettings | None) -> tuple[EmailProvider, str]:
    """Simulation unless the platform is in live mode and the chosen provider is configured."""
    choice = (app_settings.default_email_provider if app_settings else "simulation") or "simulation"
    if settings.COMMUNICATION_MODE != "live" or choice == "simulation":
        return SimulationEmailProvider(), "simulation"
    if choice == "brevo" and settings.BREVO_API_KEY:
        from app.providers.email.brevo import BrevoEmailProvider

        return BrevoEmailProvider(settings.BREVO_API_KEY), "brevo"
    if choice == "ses":
        from app.providers.email.ses import SesEmailProvider

        return SesEmailProvider(settings.AWS_REGION, settings.AWS_ACCESS_KEY_ID, settings.AWS_SECRET_ACCESS_KEY), "ses"
    return SimulationEmailProvider(), "simulation"


def simulated_outcome(email: str) -> str:
    """Simulation mailbox rules (like the SES mailbox simulator): addresses containing 'bounce',
    'complaint' or 'reject' produce those outcomes; everything else is delivered."""
    local = email.split("@", 1)[0].lower()
    domain = email.split("@", 1)[1].lower() if "@" in email else ""
    for key in ("reject", "complaint", "softbounce", "bounce"):
        if key in local or domain.startswith(f"{key}."):
            return key
    return "delivered"


def _task_ctx(db: Session, c: EmailCampaign) -> TaskContext:
    app = db.get(Application, c.application_id)
    user = db.get(User, c.created_by_id) if c.created_by_id else None
    return TaskContext(c.organization_id, c.application_id, app, user)


def launch(campaign_id: str, max_wait_seconds: float = 0) -> str:
    """queued → materialise recipients → sending → send."""
    with SessionLocal() as db:
        c = db.scalar(select(EmailCampaign).where(EmailCampaign.id == campaign_id).with_for_update())
        if c is None or c.status not in ("queued", "sending"):
            return c.status if c else "missing"
        if c.status == "queued":
            ctx = _task_ctx(db, c)
            checks, _ = readiness(db, ctx, c)
            failing = [ch for ch in checks if not ch.ok]
            if failing:
                c.status, c.error = "failed", "; ".join(f"{ch.label}: {ch.detail}" for ch in failing)[:500]
                notify(db, c.created_by_id, type_="campaign_failed", level="error", title=f"Campaign failed: {c.name}",
                       body=c.error, link=f"/apps/{c.application_id}/email/campaigns/{c.id}",
                       organization_id=c.organization_id, application_id=c.application_id)
                db.commit()
                return "failed"
            est = estimate(db, ctx, c.audience or {})
            from app.services.billing import wallet as wl

            price, cur = wl.email_price(ctx.application.default_country if ctx.application else None)
            problem = wl.hold_or_fail(db, c, "email", price * est.eligible, cur)
            if problem:
                c.status, c.error = "failed", problem[:500]
                notify(db, c.created_by_id, type_="campaign_failed", level="error", title=f"Campaign failed: {c.name}",
                       body=c.error, link=f"/apps/{c.application_id}/email/campaigns/{c.id}",
                       organization_id=c.organization_id, application_id=c.application_id)
                db.commit()
                return "failed"
            existing = set(db.scalars(select(EmailMessage.contact_id).where(EmailMessage.campaign_id == c.id)))
            stmt = (base_query(ctx).where(audience_condition(db, ctx, c.audience or {}), eligibility_condition("email"))
                    .with_only_columns(Contact.id, Contact.email).order_by(Contact.id))
            rows, created = [], 0
            for cid, email in db.execute(stmt):
                if cid in existing:
                    continue
                rows.append({"id": new_uuid(), "organization_id": c.organization_id,
                             "application_id": c.application_id, "campaign_id": c.id, "contact_id": cid,
                             "to_email": email, "status": "queued", "attempts": 0,
                             "open_count": 0, "click_count": 0})
                if len(rows) >= 1000:
                    db.execute(EmailMessage.__table__.insert(), _stamp(rows))
                    created += len(rows)
                    rows = []
            if rows:
                db.execute(EmailMessage.__table__.insert(), _stamp(rows))
                created += len(rows)
            app_settings = db.scalar(select(ApplicationSettings).where(
                ApplicationSettings.application_id == c.application_id))
            _, pname = provider_for(app_settings)
            c.links = render.extract_links(c.html)
            c.provider = pname
            c.recipient_count = len(existing) + created
            c.excluded = est.excluded
            sender = db.get(EmailSender, c.sender_id)
            c.from_name, c.from_email = sender.from_name, sender.from_email
            c.status, c.launched_at = "sending", utcnow()
            db.commit()
            log.info("email_campaign_launched", campaign_id=c.id, recipients=c.recipient_count, provider=pname)
    return send(campaign_id, max_wait_seconds=max_wait_seconds)


def _stamp(rows: list[dict]) -> list[dict]:
    now = utcnow()
    for r in rows:
        r["created_at"] = now
        r["updated_at"] = now
    return rows


def send(campaign_id: str, max_wait_seconds: float = 0) -> str:
    """Send queued messages in batches until done, paused, cancelled, or only delayed retries remain.
    Returns the campaign status, or 'retry:<seconds>' when it should be resumed later."""
    db = SessionLocal()
    try:
        c = db.get(EmailCampaign, campaign_id)
        if c is None or c.status != "sending":
            return c.status if c else "missing"
        # Recover messages claimed by a worker that died: do not risk a duplicate send.
        db.execute(update(EmailMessage).where(
            EmailMessage.campaign_id == c.id, EmailMessage.status == "sending",
            EmailMessage.updated_at < utcnow() - STALE_SENDING,
        ).values(status="failed", error_code="interrupted",
                 error_message="Sending was interrupted; not retried to avoid a duplicate email"))
        db.commit()
        app_settings = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == c.application_id))
        provider, pname = provider_for(app_settings)
        org = db.get(Organization, c.organization_id)
        business_name = (app_settings.business_name if app_settings and app_settings.business_name else org.name)
        business_address = app_settings.business_address if app_settings else None
        rate = settings.EMAIL_RATE_PER_SECOND if pname != "simulation" else 0

        while True:
            db.refresh(c)
            if c.status != "sending":
                return c.status
            now = utcnow()
            batch = list(db.scalars(select(EmailMessage).where(
                EmailMessage.campaign_id == c.id, EmailMessage.status == "queued",
                (EmailMessage.next_attempt_at.is_(None)) | (EmailMessage.next_attempt_at <= now),
            ).order_by(EmailMessage.created_at, EmailMessage.id).limit(BATCH)))
            if not batch:
                pending = db.scalar(select(EmailMessage.next_attempt_at).where(
                    EmailMessage.campaign_id == c.id, EmailMessage.status == "queued")
                    .order_by(EmailMessage.next_attempt_at).limit(1))
                if pending is None:
                    return _finish(db, c)
                wait = max(1.0, (pending - utcnow()).total_seconds())
                if wait <= max_wait_seconds:
                    time.sleep(wait)
                    continue
                return f"retry:{int(wait)}"
            ids = [m.id for m in batch]
            claimed = db.execute(update(EmailMessage).where(EmailMessage.id.in_(ids), EmailMessage.status == "queued")
                                 .values(status="sending", updated_at=utcnow())).rowcount
            db.commit()
            if claimed != len(ids):
                batch = list(db.scalars(select(EmailMessage).where(EmailMessage.id.in_(ids),
                                                                   EmailMessage.status == "sending")))
            started = time.monotonic()
            _send_batch(db, c, batch, provider, pname, business_name, business_address)
            db.commit()
            if rate:
                min_duration = len(batch) / rate
                elapsed = time.monotonic() - started
                if elapsed < min_duration:
                    time.sleep(min_duration - elapsed)
    finally:
        db.close()


def _send_batch(db: Session, c: EmailCampaign, batch: list[EmailMessage], provider: EmailProvider, pname: str,
                business_name: str | None, business_address: str | None) -> None:
    contacts = {x.id: x for x in db.scalars(select(Contact).where(Contact.id.in_([m.contact_id for m in batch if m.contact_id])))}
    hashes = {identifier_hash(m.to_email) for m in batch}
    suppressed = set(db.scalars(select(SuppressionEntry.value_hash).where(
        SuppressionEntry.application_id == c.application_id, SuppressionEntry.channel == "email",
        SuppressionEntry.value_hash.in_(hashes))))
    for m in batch:
        contact = contacts.get(m.contact_id)
        reason = None
        if contact is None:
            reason = "Contact was deleted"
        elif contact.email != m.to_email:
            reason = "Contact's email address changed"
        elif contact.email_unsubscribed_at is not None or not contact.email_consent:
            reason = "Contact withdrew consent"
        elif identifier_hash(m.to_email) in suppressed:
            reason = "Address is on the suppression list"
        elif contact.status in ("bounced", "blocked"):
            reason = f"Contact is {contact.status}"
        if reason:
            m.status, m.error_code, m.error_message = "skipped", "ineligible", reason
            continue
        m.attempts += 1
        m.provider = pname
        try:
            r = render.render(subject=c.subject, preheader=c.preheader, html=c.html, text=c.text,
                              values=render.contact_values(contact), message_id=m.id, links=c.links,
                              business_name=business_name, business_address=business_address,
                              track_opens=c.track_opens, track_clicks=c.track_clicks)
            outcome = simulated_outcome(m.to_email) if pname == "simulation" else None
            if outcome == "reject":
                m.status, m.error_code, m.error_message = "failed", "rejected", "Rejected by provider (simulated)"
                events.apply(db, m, "failed", provider=pname, provider_event_id=f"{m.id}:failed")
                continue
            res = provider.send(OutboundEmail(
                to_email=m.to_email, to_name=contact.full_name or None, subject=r.subject, html=r.html, text=r.text,
                from_email=c.from_email, from_name=c.from_name, reply_to=c.reply_to, headers=r.headers,
                tags=(f"campaign:{c.id}",), idempotency_key=m.id))
        except TransientProviderError as exc:
            if m.attempts >= MAX_ATTEMPTS:
                m.status, m.error_code, m.error_message = "failed", "retries_exhausted", str(exc)[:500]
            else:
                m.status = "queued"
                m.next_attempt_at = utcnow() + timedelta(seconds=min(30 * 2 ** (m.attempts - 1), 1800))
                m.error_code, m.error_message = "transient", str(exc)[:500]
            continue
        except Exception as exc:  # noqa: BLE001 - never loop on an unexpected error
            log.exception("email_send_error", message_id=m.id)
            m.status, m.error_code, m.error_message = "failed", "internal_error", type(exc).__name__
            continue
        if not res.accepted:
            m.status, m.error_code, m.error_message = "failed", res.error_code, res.error_message
            events.apply(db, m, "failed", provider=pname, provider_event_id=f"{m.id}:failed",
                         meta={"error_code": res.error_code})
            continue
        m.provider_message_id = res.provider_message_id
        m.error_code = m.error_message = None
        events.apply(db, m, "accepted", provider=pname, provider_event_id=f"{m.id}:accepted")
        if pname == "simulation":
            # Simulated delivery receipts, applied through the same path as real webhooks.
            if outcome == "delivered":
                events.apply(db, m, "delivered", provider=pname, provider_event_id=f"sim:{m.id}:delivered")
            elif outcome in ("bounce", "softbounce"):
                events.apply(db, m, "bounced", provider=pname, provider_event_id=f"sim:{m.id}:bounced",
                             bounce_type="soft" if outcome == "softbounce" else "hard")
            elif outcome == "complaint":
                events.apply(db, m, "delivered", provider=pname, provider_event_id=f"sim:{m.id}:delivered")
                events.apply(db, m, "complained", provider=pname, provider_event_id=f"sim:{m.id}:complained")


def _finish(db: Session, c: EmailCampaign) -> str:
    c.status, c.completed_at = "completed", utcnow()
    from app.services.email.campaigns import stats_for

    st = stats_for(db, [c.id]).get(c.id)
    if c.created_by_id and st is not None:
        problems = st.failed + st.bounced
        notify(db, c.created_by_id, type_="campaign_sent", level="warning" if problems else "success",
               title=f"Campaign sent: {c.name}",
               body=f"{st.sent:,} sent to the provider" + (f", {problems:,} failed or bounced" if problems else ""),
               link=f"/apps/{c.application_id}/email/campaigns/{c.id}",
               organization_id=c.organization_id, application_id=c.application_id)
    db.commit()
    log.info("email_campaign_completed", campaign_id=c.id)
    return "completed"


def dispatch_due() -> int:
    """Move due scheduled campaigns to the queue."""
    from app.tasks.email import launch_email_campaign
    from app.workers.dispatch import dispatch

    with SessionLocal() as db:
        due = list(db.scalars(select(EmailCampaign).where(EmailCampaign.status == "scheduled",
                                                          EmailCampaign.scheduled_at <= utcnow()).with_for_update()))
        for c in due:
            c.status = "queued"
        db.commit()
        ids = [c.id for c in due]
    for i in ids:
        dispatch(launch_email_campaign, i)
    return len(ids)

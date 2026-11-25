"""Background calling.

* Recipients are materialised once into voice_calls, unique per (campaign, contact).
* A call is claimed (queued/deferred → placing) before the provider request. A call left in
  "placing" by a dead worker is marked failed, never re-dialled; a call that never reports an
  outcome is closed after STALE_IN_FLIGHT. At-most-once: nobody is called twice by accident.
* Eligibility (consent, suppression, country) is re-checked before every attempt.
* Calls only go out inside the allowed window in the recipient's time zone (legal window for
  marketing calls plus the application's quiet hours); others wait for the window to open.
* Live calls are limited to VOICE_MAX_CONCURRENT_CALLS in flight per campaign.
"""
import threading
import time
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Application, ApplicationSettings, Contact, SuppressionEntry, User
from app.models.base import new_uuid
from app.models.voice import VoiceCall, VoiceCampaign
from app.providers.voice.base import OutboundCall, TransientVoiceError, VoiceProvider
from app.providers.voice.factory import provider_for
from app.providers.voice.simulation import simulated_outcome
from app.services.audience.import_processor import TaskContext
from app.services.audience.query import base_query, eligibility_condition
from app.services.email import render, tokens
from app.services.email.campaigns import audience_condition
from app.services.notification_service import notify
from app.services.voice import events, rules, script
from app.services.voice.campaigns import (
    IN_FLIGHT,
    PENDING,
    caller_kinds,
    campaign_country,
    cost_estimate,
    draft_snapshot,
    estimate,
    readiness,
    stats_for,
)
from app.utils.contact_normalize import identifier_hash
from app.utils.time import utcnow

log = get_logger(__name__)
BATCH = 50
STALE_PLACING = timedelta(minutes=10)
STALE_IN_FLIGHT = timedelta(hours=2)
TRANSIENT_RETRIES = 3

_running: set[str] = set()
_lock = threading.Lock()


def _task_ctx(db: Session, c: VoiceCampaign) -> TaskContext:
    return TaskContext(c.organization_id, c.application_id, db.get(Application, c.application_id),
                       db.get(User, c.created_by_id) if c.created_by_id else None)


def launch(campaign_id: str) -> str:
    with SessionLocal() as db:
        c = db.scalar(select(VoiceCampaign).where(VoiceCampaign.id == campaign_id).with_for_update())
        if c is None or c.status not in ("queued", "sending"):
            return c.status if c else "missing"
        if c.status == "queued":
            ctx = _task_ctx(db, c)
            failing = [ch for ch in readiness(db, ctx, c)[0] if not ch.ok]
            if failing:
                c.status, c.error = "failed", "; ".join(f"{ch.label}: {ch.detail}" for ch in failing)[:500]
                notify(db, c.created_by_id, type_="campaign_failed", level="error",
                       title=f"Voice campaign failed: {c.name}", body=c.error,
                       link=f"/apps/{c.application_id}/voice/campaigns/{c.id}", organization_id=c.organization_id,
                       application_id=c.application_id)
                db.commit()
                return "failed"
            country = campaign_country(db, c)
            est = estimate(db, ctx, c.audience or {}, country)
            from app.services.billing import wallet as wl

            # Frozen now: the caller and the message (for AI agents, the agent's version and behaviour).
            snap0 = draft_snapshot(db, c)
            ai_call = snap0.get("message_type") == "ai_agent"
            agent_id = (snap0.get("agent") or {}).get("id") if ai_call else None
            cost0 = cost_estimate(est.eligible, script.estimated_seconds(snap0), country, ai=ai_call)
            problem = wl.hold_or_fail(db, c, "voice", cost0["total"], cost0["currency"])
            if problem:
                c.status, c.error = "failed", problem[:500]
                db.commit()
                return "failed"
            existing = set(db.scalars(select(VoiceCall.contact_id).where(VoiceCall.campaign_id == c.id)))
            stmt = (base_query(ctx).where(audience_condition(db, ctx, c.audience or {}), eligibility_condition("voice"),
                                          Contact.phone_country == country)
                    .with_only_columns(Contact.id, Contact.phone).order_by(Contact.id))
            rows, created, now = [], 0, utcnow()
            for cid, phone in db.execute(stmt):
                if cid in existing:
                    continue
                rows.append({"id": new_uuid(), "organization_id": c.organization_id, "application_id": c.application_id,
                             "campaign_id": c.id, "contact_id": cid, "to_phone": phone, "country": country,
                             "status": "queued", "attempts": 0, "duration_seconds": 0, "billable_minutes": 0,
                             "opted_out": False, "agent_id": agent_id, "created_at": now, "updated_at": now})
                if len(rows) >= 1000:
                    db.execute(VoiceCall.__table__.insert(), rows)
                    created, rows = created + len(rows), []
            if rows:
                db.execute(VoiceCall.__table__.insert(), rows)
                created += len(rows)
            snap = snap0
            # Each call picks its Signalcraft number (and so its provider) at dial time.
            pname = "auto" if settings.COMMUNICATION_MODE == "live" else "simulation"
            cost = cost_estimate(len(existing) + created, script.estimated_seconds(snap), country, ai=ai_call)
            c.snapshot, c.provider, c.currency = snap, pname, cost["currency"]
            c.recipient_count, c.excluded = len(existing) + created, est.excluded
            c.estimated_cost = Decimal(str(cost["total"]))
            c.status, c.launched_at = "sending", utcnow()
            db.commit()
            log.info("voice_campaign_launched", campaign_id=c.id, recipients=c.recipient_count, provider=pname)
    return run(campaign_id)


def run(campaign_id: str, max_wait_seconds: float = 0) -> str:
    """Place due calls until none are due. Returns the status, 'retry:<s>' or 'waiting' (calls in flight)."""
    with _lock:
        if campaign_id in _running:
            return "already_running"
        _running.add(campaign_id)
    db = SessionLocal()
    try:
        c = db.get(VoiceCampaign, campaign_id)
        if c is None or c.status != "sending":
            return c.status if c else "missing"
        now = utcnow()
        db.execute(update(VoiceCall).where(VoiceCall.campaign_id == c.id, VoiceCall.status == "placing",
                                           VoiceCall.updated_at < now - STALE_PLACING)
                   .values(status="failed", error_code="interrupted", ended_at=now,
                           error_message="Dialling was interrupted; not retried to avoid calling twice"))
        db.execute(update(VoiceCall).where(VoiceCall.campaign_id == c.id, VoiceCall.status.in_(IN_FLIGHT),
                                           VoiceCall.updated_at < now - STALE_IN_FLIGHT)
                   .values(status="failed", error_code="no_status", ended_at=now,
                           error_message="The provider never reported how the call ended"))
        db.commit()
        snap = c.snapshot or {}
        pname = "auto" if settings.COMMUNICATION_MODE == "live" else "simulation"
        app = db.get(Application, c.application_id)
        s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == c.application_id))
        quiet = (s.quiet_hours_start, s.quiet_hours_end) if s else ("21:00", "09:00")
        rate = settings.VOICE_CALLS_PER_SECOND if pname != "simulation" else 0
        while True:
            db.refresh(c)
            if c.status != "sending":
                return c.status
            limit = BATCH
            if pname != "simulation":
                in_flight = db.scalar(select(func.count()).select_from(VoiceCall).where(
                    VoiceCall.campaign_id == c.id, VoiceCall.status.in_(IN_FLIGHT))) or 0
                limit = min(BATCH, settings.VOICE_MAX_CONCURRENT_CALLS - in_flight)
                if limit <= 0:
                    return "waiting"
            now = utcnow()
            batch = list(db.scalars(select(VoiceCall).where(
                VoiceCall.campaign_id == c.id, VoiceCall.status.in_(PENDING),
                (VoiceCall.next_attempt_at.is_(None)) | (VoiceCall.next_attempt_at <= now),
            ).order_by(VoiceCall.created_at, VoiceCall.id).limit(limit)))
            if not batch:
                return finish_if_done(db, c, max_wait_seconds)
            ids = [m.id for m in batch]
            db.execute(update(VoiceCall).where(VoiceCall.id.in_(ids), VoiceCall.status.in_(PENDING))
                       .values(status="placing", updated_at=utcnow()))
            db.commit()
            batch = list(db.scalars(select(VoiceCall).where(VoiceCall.id.in_(ids), VoiceCall.status == "placing")))
            started = time.monotonic()
            _place_batch(db, c, app, quiet, batch)
            db.commit()
            if snap.get("message_type") == "ai_agent" and pname == "simulation":
                from app.services.voice import ai_results

                for call in batch:
                    ai_results.process(call.id)
            if rate and batch:
                wait = len(batch) / rate - (time.monotonic() - started)
                if wait > 0:
                    time.sleep(wait)
    finally:
        db.close()
        with _lock:
            _running.discard(campaign_id)


def _ineligible(contact: Contact | None, call: VoiceCall, suppressed: set[str]) -> str | None:
    if contact is None:
        return "Contact was deleted"
    if contact.phone != call.to_phone:
        return "Contact's phone number changed"
    if contact.voice_unsubscribed_at is not None or not contact.voice_consent:
        return "Contact withdrew consent to calls"
    if identifier_hash(call.to_phone) in suppressed:
        return "Number is on the suppression list"
    if contact.status == "blocked":
        return "Contact is blocked"
    if contact.phone_country != call.country:
        return "Number is not in this campaign's country"
    return None


def _place_batch(db: Session, c: VoiceCampaign, app: Application, quiet: tuple[str, str],
                 batch: list[VoiceCall]) -> None:
    from app.services.voice.numbers import pick_caller

    snap = c.snapshot or {}
    ai_call = snap.get("message_type") == "ai_agent"
    providers: dict[str, tuple[VoiceProvider, str]] = {}
    contacts = {x.id: x for x in db.scalars(select(Contact).where(
        Contact.id.in_([m.contact_id for m in batch if m.contact_id])))}
    suppressed = set(db.scalars(select(SuppressionEntry.value_hash).where(
        SuppressionEntry.application_id == c.application_id, SuppressionEntry.channel == "voice",
        SuppressionEntry.value_hash.in_({identifier_hash(m.to_phone) for m in batch}))))
    for call in batch:
        contact = contacts.get(call.contact_id)
        reason = _ineligible(contact, call, suppressed)
        if reason:
            call.status, call.error_code, call.error_message = "skipped", "ineligible", reason
            continue
        resume_at = rules.next_allowed(utcnow(), contact.timezone or app.timezone, call.country, c.category, quiet)
        if resume_at is not None:
            call.status, call.next_attempt_at, call.deferred_reason = "deferred", resume_at, "calling_window"
            continue
        # Signalcraft picks the caller number: stable per contact, of the kind this call category needs.
        pn = pick_caller(db, country=call.country, kind=caller_kinds(call.country, c.category),
                         contact_id=call.contact_id, twilio_only=ai_call)
        if pn is None:
            call.status, call.error_code, call.ended_at = "failed", "no_caller_number", utcnow()
            call.error_message = "Calling to this country isn't available yet"
            continue
        if pn.provider not in providers:
            providers[pn.provider] = provider_for(pn.provider)
        provider, pname = providers[pn.provider]
        call.attempts += 1
        call.provider = pname
        call.from_number = pn.number
        call.deferred_reason = None
        call.answered_at = call.answered_by = call.ended_at = None
        sc = script.build(snap, contact, call.id)
        try:
            res = provider.place(OutboundCall(
                to=call.to_phone, caller_id=pn.number, script=sc,
                status_callback=script.status_callback(pname, call.id, call.attempts),
                script_url=render.public_url(f"/public/voice/script/{tokens.make('vs', call.id)}"),
                idempotency_key=f"{call.id}:{call.attempts}"))
        except TransientVoiceError as exc:
            if call.attempts >= TRANSIENT_RETRIES:
                call.status, call.error_code, call.error_message = "failed", "retries_exhausted", str(exc)[:500]
                call.ended_at = utcnow()
            else:
                call.attempts -= 1  # the call never started; do not count it against the recipient
                call.status, call.next_attempt_at = "queued", utcnow() + timedelta(minutes=2)
                call.error_code, call.error_message = "transient", str(exc)[:500]
            continue
        except Exception as exc:  # noqa: BLE001
            log.exception("voice_place_error", call_id=call.id)
            call.status, call.error_code, call.error_message = "failed", "internal_error", type(exc).__name__
            call.ended_at = utcnow()
            continue
        if not res.accepted:
            events.apply(db, call, "failed", provider=pname, provider_event_id=f"{call.id}:{call.attempts}:failed",
                         error_code=res.error_code, error_message=res.error_message)
            continue
        call.provider_call_id = res.provider_call_id
        call.next_attempt_at = None
        events.apply(db, call, "placed", provider=pname, provider_event_id=f"{call.id}:{call.attempts}:placed")
        if pname == "simulation":
            if snap.get("message_type") == "ai_agent":
                _simulate_ai(db, call, snap, contact)
            else:
                _simulate(db, call, snap)


def simulated_caller_lines(outcome: str, first_name: str | None) -> list[str]:
    """What the simulated person says, turn by turn."""
    if outcome == "opt_out":
        return ["Hello?", "Please stop calling me. I'm not interested."]
    return [f"Hi, yes, this is {first_name or 'me'}.", "Sure, that sounds interesting. Tell me more.",
            "Yes, I'm interested. Can you call me back tomorrow?", "Okay, thanks. Bye."]


def _simulate_ai(db: Session, call: VoiceCall, snap: dict, contact: Contact | None) -> None:
    """An AI-agent conversation with a scripted simulated person (offline responder, or Claude when configured)."""
    from app.services.voice import ai

    outcome = simulated_outcome(call.to_phone)
    key = f"sim:{call.provider_call_id}"
    events.apply(db, call, "ringing", provider="simulation", provider_event_id=f"{key}:ringing")
    if outcome in ("no_answer", "busy"):
        events.apply(db, call, outcome, provider="simulation", provider_event_id=f"{key}:{outcome}")
        return
    machine = outcome == "voicemail"
    events.apply(db, call, "answered", provider="simulation", provider_event_id=f"{key}:answered",
                 answered_by="machine" if machine else "human")
    agent = snap.get("agent") or {}
    values = ai.values_for(None, snap.get("business_name") or "us", contact)
    transcript = [{"role": "assistant", "text": ai.greeting_for(agent, values), "at": utcnow().isoformat()}]
    if not machine:
        for line in simulated_caller_lines(outcome, contact.first_name if contact else None):
            transcript.append({"role": "user", "text": line, "at": utcnow().isoformat()})
            r = ai.reply_sync(agent, [{"role": t["role"], "content": t["text"]} for t in transcript], values)
            transcript.append({"role": "assistant", "text": r["text"], "at": utcnow().isoformat(),
                               **({"simulated": True} if r.get("simulated") else {})})
            if r["end"] or r["transfer"]:
                break
    call.transcript = transcript
    seconds = int(sum(rules.spoken_seconds(t["text"]) for t in transcript) + 3 * len(transcript))
    events.apply(db, call, "completed", provider="simulation", provider_event_id=f"{key}:completed",
                 duration=max(seconds, 1), answered_by="machine" if machine else "human")


def _simulate(db: Session, call: VoiceCall, snap: dict) -> None:
    """Simulated provider callbacks, applied through the same path as real ones."""
    outcome = simulated_outcome(call.to_phone)
    key = f"sim:{call.provider_call_id}"
    seconds = int(round(script.estimated_seconds(snap)))
    if outcome in ("no_answer", "busy"):
        events.apply(db, call, "ringing", provider="simulation", provider_event_id=f"{key}:ringing")
        events.apply(db, call, outcome, provider="simulation", provider_event_id=f"{key}:{outcome}")
        return
    events.apply(db, call, "ringing", provider="simulation", provider_event_id=f"{key}:ringing")
    machine = outcome == "voicemail"
    events.apply(db, call, "answered", provider="simulation", provider_event_id=f"{key}:answered",
                 answered_by="machine" if machine else "human")
    if outcome == "opt_out":
        events.apply(db, call, "keypress", provider="simulation", provider_event_id=f"{key}:keypress",
                     digits=rules.OPT_OUT_DIGIT)
    events.apply(db, call, "completed", provider="simulation", provider_event_id=f"{key}:completed",
                 duration=max(seconds, 1), answered_by="machine" if machine else "human")


def finish_if_done(db: Session, c: VoiceCampaign, max_wait_seconds: float = 0) -> str:
    """Complete the campaign when nothing is pending or in flight; otherwise say when to look again."""
    in_flight = db.scalar(select(func.count()).select_from(VoiceCall).where(
        VoiceCall.campaign_id == c.id, VoiceCall.status.in_(IN_FLIGHT))) or 0
    pending = db.scalar(select(func.min(VoiceCall.next_attempt_at)).where(
        VoiceCall.campaign_id == c.id, VoiceCall.status.in_(PENDING)))
    has_pending = db.scalar(select(func.count()).select_from(VoiceCall).where(
        VoiceCall.campaign_id == c.id, VoiceCall.status.in_(PENDING))) or 0
    if in_flight:
        return "waiting"
    if has_pending:
        wait = max(1.0, (pending - utcnow()).total_seconds()) if pending else 1.0
        return f"retry:{int(wait)}"
    if c.status != "sending":
        return c.status
    c.status, c.completed_at = "completed", utcnow()
    st = stats_for(db, [c.id]).get(c.id)
    if c.created_by_id and st is not None:
        notify(db, c.created_by_id, type_="campaign_sent", level="success",
               title=f"Voice campaign finished: {c.name}",
               body=f"{st.answered:,} answered, {st.voicemail:,} voicemail, {st.no_answer + st.busy:,} not reached",
               link=f"/apps/{c.application_id}/voice/campaigns/{c.id}", organization_id=c.organization_id,
               application_id=c.application_id)
    db.commit()
    log.info("voice_campaign_completed", campaign_id=c.id)
    return "completed"


def dispatch_due() -> int:
    """Queue due scheduled campaigns, wake campaigns with calls due, and close finished ones."""
    from app.tasks.voice import continue_voice_campaign, launch_voice_campaign
    from app.workers.dispatch import dispatch

    now = utcnow()
    with SessionLocal() as db:
        due = list(db.scalars(select(VoiceCampaign).where(VoiceCampaign.status == "scheduled",
                                                          VoiceCampaign.scheduled_at <= now).with_for_update()))
        for c in due:
            c.status = "queued"
        db.commit()
        launch_ids = [c.id for c in due]
        sending = list(db.scalars(select(VoiceCampaign).where(VoiceCampaign.status == "sending")))
        wake = []
        for c in sending:
            due_calls = db.scalar(select(func.count()).select_from(VoiceCall).where(
                VoiceCall.campaign_id == c.id, VoiceCall.status.in_(PENDING),
                (VoiceCall.next_attempt_at.is_(None)) | (VoiceCall.next_attempt_at <= now))) or 0
            if due_calls:
                wake.append(c.id)
            elif c.id not in _running:
                finish_if_done(db, c)
    for i in launch_ids:
        dispatch(launch_voice_campaign, i)
    with _lock:
        wake = [i for i in wake if i not in _running]
    for i in wake:
        dispatch(continue_voice_campaign, i)
    return len(launch_ids) + len(wake)

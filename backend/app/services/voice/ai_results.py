"""After an AI-agent call: extract what was said and push it into the CRM.

* Summary, sentiment, interest, next step and the agent's outcome fields are stored on the call.
* The contact's timeline gets an "AI call" activity linking to the call.
* A hot lead or a requested call back creates a task for the contact's owner.
* "Don't call me again" is applied as a voice opt-out (consent withdrawn and number suppressed).
* An `ai_call_completed` CRM event is recorded so automations can start from it.
Each call is processed once (ai_processed_at)."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Application, Contact, CrmActivity
from app.models.voice import VoiceCall, VoiceCampaign
from app.schemas.crm import TaskCreate
from app.services import uae
from app.services.crm.common import contact_name, record_event, system_ctx
from app.services.voice import ai, events
from app.utils.time import utcnow

log = get_logger(__name__)
FINAL = ("completed", "voicemail", "no_answer", "busy", "failed", "skipped")
INTEREST_LABEL = {"hot": "Hot", "warm": "Warm", "cold": "Cold", "not_interested": "Not interested"}


def _business_name(db: Session, c: VoiceCampaign) -> str:
    from app.models import ApplicationSettings, Organization

    s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == c.application_id))
    if s and s.business_name:
        return s.business_name
    org = db.get(Organization, c.organization_id)
    return org.name if org else "us"


def _parse_when(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=ZoneInfo("UTC"))


def next_business_day(tz_name: str | None) -> datetime:
    """10:00 local time on the next weekday."""
    try:
        tz = ZoneInfo(tz_name or "UTC")
    except Exception:  # noqa: BLE001
        tz = ZoneInfo("UTC")
    d = utcnow().astimezone(tz) + timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.replace(hour=10, minute=0, second=0, microsecond=0).astimezone(ZoneInfo("UTC"))


def _had_conversation(call: VoiceCall) -> bool:
    return any(t.get("role") == "user" and (t.get("text") or "").strip() for t in (call.transcript or []))


def process_call(db: Session, call: VoiceCall) -> bool:
    """Returns True when the call was processed now."""
    if call.ai_processed_at is not None or not call.agent_id or call.status not in FINAL:
        return False
    campaign = db.get(VoiceCampaign, call.campaign_id)
    agent = (campaign.snapshot or {}).get("agent") if campaign else None
    if not agent or not _had_conversation(call):
        call.ai_processed_at = utcnow()
        return True
    contact = db.get(Contact, call.contact_id) if call.contact_id else None
    values = ai.values_for(None, _business_name(db, campaign), contact)
    out = ai.extract(agent, call.transcript or [], values)
    call.ai_summary = (out.get("summary") or "Summary unavailable")[:4000]
    call.ai_sentiment, call.ai_interest = out.get("sentiment"), out.get("interest")
    call.ai_next_step = (out.get("next_step") or None) and out["next_step"][:500]
    call.ai_outcomes = {**(out.get("outcomes") or {}),
                        **({"_callback_requested_at": out["callback_requested_at"]}
                           if out.get("callback_requested_at") else {}),
                        **({"_do_not_call": True} if out.get("do_not_call") else {}),
                        **({"_simulated": True} if out.get("simulated") else {})}
    call.ai_processed_at = utcnow()
    if contact is not None and contact.application_id == call.application_id:
        _to_crm(db, call, campaign, contact, out)
    if out.get("do_not_call"):
        events.opt_out(db, call, method="ai_call", source="Asked not to be called again during an AI call")
    elif call.country == "AE" and out.get("interest") in uae.REFUSAL_INTERESTS:
        # UAE (Resolution 56/2024): a refusal means the contact is never called for marketing again.
        events.opt_out(db, call, method="ai_call", source="Refused during an AI call (UAE: never call again)")
    return True


def _to_crm(db: Session, call: VoiceCall, campaign: VoiceCampaign, contact: Contact, out: dict) -> None:
    from app.services.crm import work

    interest = out.get("interest")
    labels = {f.get("key"): f.get("label") for f in ((campaign.snapshot or {}).get("agent") or {}).get(
        "outcome_fields", [])}
    captured = [{"key": k, "label": labels.get(k, k), "value": v} for k, v in (out.get("outcomes") or {}).items()]
    db.add(CrmActivity(
        organization_id=call.organization_id, application_id=call.application_id, type="ai_call",
        subject=f"AI call: {INTEREST_LABEL.get(interest, 'completed')}"[:200], body=call.ai_summary,
        outcome=interest, duration_minutes=max(1, round((call.duration_seconds or 0) / 60)) if call.duration_seconds
        else None, occurred_at=call.ended_at or utcnow(), actor_user_id=None, contact_id=contact.id,
        company_id=contact.company_id,
        meta={"voice_call_id": call.id, "campaign_id": campaign.id, "campaign": campaign.name,
              "sentiment": out.get("sentiment"), "interest": interest, "next_step": out.get("next_step"),
              "outcomes": captured, "simulated": bool(out.get("simulated"))}))
    at = call.ended_at or utcnow()
    contact.last_activity_at = max(contact.last_activity_at or at, at)
    record_event(db, call.organization_id, call.application_id, "ai_call_completed", contact_id=contact.id,
                 data={"interest": interest, "sentiment": out.get("sentiment"), "call_id": call.id,
                       "campaign_id": campaign.id})
    callback = _parse_when(out.get("callback_requested_at"))
    if (callback or interest == "hot") and not out.get("do_not_call"):
        app = db.get(Application, call.application_id)
        due = callback if callback and callback > utcnow() else next_business_day(
            contact.timezone or (app.timezone if app else None))
        ctx = system_ctx(db, call.organization_id, call.application_id)
        notes = "\n".join(x for x in [f"From the AI call in “{campaign.name}”.", call.ai_summary,
                                       f"Next step: {out['next_step']}" if out.get("next_step") else None] if x)
        work.create_task(db, ctx, TaskCreate(title=f"Call back {contact_name(contact)}"[:200], type="call",
                                             priority="high" if interest == "hot" else "normal", due_at=due,
                                             notes=notes[:5000], contact_id=contact.id))


def process(call_id: str) -> str:
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        if call is None:
            return "missing"
        try:
            done = process_call(db, call)
            db.commit()
            return "processed" if done else "skipped"
        except Exception:
            db.rollback()
            log.exception("ai_call_processing_failed", call_id=call_id)
            return "error"


def pending_ids(db: Session, limit: int = 50) -> list[str]:
    return list(db.scalars(select(VoiceCall.id).where(
        VoiceCall.agent_id.is_not(None), VoiceCall.ai_processed_at.is_(None), VoiceCall.status.in_(FINAL))
        .order_by(VoiceCall.ended_at).limit(limit)))


def sweep() -> int:
    """Process finished AI calls that were missed (worker restarts, callbacks processed elsewhere)."""
    with SessionLocal() as db:
        ids = pending_ids(db)
    return sum(1 for i in ids if process(i) == "processed")

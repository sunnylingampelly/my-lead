"""Voice campaign lifecycle: draft → scheduled/queued → sending ⇄ paused → completed | cancelled | failed."""
from collections import Counter
from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import case, exists, func, not_, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import ApplicationSettings, Contact, SuppressionEntry
from app.models.voice import VoiceAgent, VoiceAudio, VoiceCall, VoiceCampaign
from app.providers.voice.base import OutboundCall
from app.providers.voice.factory import provider_for
from app.schemas.common import Page, PageParams
from app.schemas.email import Estimate, ReadinessCheck, ScheduleRequest
from app.schemas.voice import CallOut, CampaignCreate, CampaignListItem, CampaignOut, CampaignUpdate, Stats, TestCall
from app.services import audit_service, uae
from app.services.audience.query import base_query, count, eligibility_condition
from app.services.email import readiness as rd
from app.services.email import render
from app.services.email.campaigns import audience_condition, capped_ids, custom_keys, initial_audience
from app.services.sms.registration import dlt_row
from app.services.tenancy import AppContext
from app.services.voice import rules, script
from app.utils.contact_normalize import parse_phone
from app.utils.time import utcnow

EDITABLE = ("draft",)
ACTIVE = ("queued", "sending", "paused")
PENDING = ("queued", "deferred")
IN_FLIGHT = ("placing", "dialing", "ringing", "in_progress")
ANSWERED = ("completed", "voicemail")
COUNTRY_NAME = {"IN": "India", "AE": "the UAE", "US": "the United States"}
# What applies to UAE calls once they are switched on (shown with the "coming soon" state).
UAE_RULES = (
    "Calls only 09:00–18:00 UAE time, Monday to Friday",
    "Calls come from your own licensed UAE number",
    "Every call starts with a recording notice and, for AI agents, an AI disclosure",
    "Anyone who says no is never called again",
    "Unanswered calls are retried at most once a day and twice a week",
    "Numbers on the UAE Do Not Call Registry (DNCR) are never called",
)



def _visible(ctx) -> tuple:
    """Campaigns shown in lists and overviews: this application's, without hidden automation steps."""
    return (VoiceCampaign.application_id == ctx.application_id, VoiceCampaign.status != "automation")

def _get(db: Session, ctx, campaign_id: str, lock: bool = False) -> VoiceCampaign:
    q = select(VoiceCampaign).where(VoiceCampaign.id == campaign_id, VoiceCampaign.application_id == ctx.application_id)
    if lock:
        q = q.with_for_update()
    c = db.scalar(q)
    if c is None:
        raise NotFound("Campaign not found")
    return c


def campaign_country(db: Session, c: VoiceCampaign) -> str | None:
    """Calls go to the application's market (India or the United States). The caller number is picked
    by Signalcraft for every call; campaigns no longer choose one (caller_ref is ignored)."""
    from app.models import Application

    app = db.get(Application, c.application_id)
    country = (getattr(app, "default_country", None) or "").upper()
    return country if country in ("IN", "AE", "US") else None


def caller_kinds(country: str | None, category: str) -> tuple[str, ...]:
    from app.services.voice.numbers import kinds_for

    return kinds_for(country, category)


class _Caller:
    """What the snapshot records about the caller: the market and the kind of number calls come from."""

    def __init__(self, country: str | None, kind: str):
        self.number, self.country, self.kind, self.provider = "", country or "", kind, "auto"


def audio_of(db: Session, c: VoiceCampaign) -> VoiceAudio | None:
    a = db.get(VoiceAudio, c.audio_id) if c.audio_id else None
    return a if a is not None and a.application_id == c.application_id else None


def agent_of(db: Session, c: VoiceCampaign) -> VoiceAgent | None:
    a = db.get(VoiceAgent, c.agent_id) if c.agent_id else None
    return a if a is not None and a.application_id == c.application_id else None


def message_type_of(db: Session, c: VoiceCampaign) -> str | None:
    """audio | tts | ai_agent. Older campaigns have no type; it follows their recording or script."""
    if c.message_type:
        return c.message_type
    audio = audio_of(db, c)
    return ("tts" if audio.kind == "tts" else "audio") if audio else None


def is_ai(db: Session, c: VoiceCampaign) -> bool:
    return message_type_of(db, c) == "ai_agent"


def stats_for(db: Session, campaign_ids: list[str]) -> dict[str, Stats]:
    if not campaign_ids:
        return {}
    m = VoiceCall
    s = lambda cond: func.sum(case((cond, 1), else_=0))  # noqa: E731
    rows = db.execute(select(
        m.campaign_id, func.count(), s(m.status == "queued"), s(m.status == "deferred"), s(m.status.in_(IN_FLIGHT)),
        s(m.attempts > 0), s(m.status == "completed"), s(m.status == "voicemail"), s(m.status == "no_answer"),
        s(m.status == "busy"), s(m.status == "failed"), s(m.status == "skipped"), s(m.opted_out.is_(True)),
        func.coalesce(func.sum(m.attempts), 0), func.coalesce(func.sum(m.duration_seconds), 0),
        func.coalesce(func.sum(m.billable_minutes), 0), func.coalesce(func.sum(m.cost), 0),
    ).where(m.campaign_id.in_(campaign_ids)).group_by(m.campaign_id)).all()
    return {r[0]: Stats(recipients=r[1], pending=r[2] or 0, deferred=r[3] or 0, in_progress=r[4] or 0,
                        attempted=r[5] or 0, answered=r[6] or 0, voicemail=r[7] or 0, no_answer=r[8] or 0,
                        busy=r[9] or 0, failed=r[10] or 0, skipped=r[11] or 0, opted_out=r[12] or 0,
                        attempts=int(r[13] or 0), talk_seconds=int(r[14] or 0), billable_minutes=int(r[15] or 0),
                        cost=round(float(r[16] or 0), 4)) for r in rows}


def to_out(db: Session, c: VoiceCampaign) -> CampaignOut:
    out = CampaignOut.model_validate(c)
    out.message_type = message_type_of(db, c)
    out.stats = stats_for(db, [c.id]).get(c.id, Stats())
    return out


def business_name(db: Session, ctx) -> str:
    s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == ctx.application_id))
    if s and s.business_name:
        return s.business_name
    org = getattr(ctx, "organization", None)
    return org.name if org is not None else (ctx.application.name if ctx.application else "us")


# ------------------------------------------------------------------ audience & cost


def estimate(db: Session, ctx, audience: dict, country: str | None) -> Estimate:
    base = base_query(ctx).where(audience_condition(db, ctx, audience))
    matched = count(db, base)
    eligible_q = base.where(eligibility_condition("voice"))
    if country:
        eligible_q = eligible_q.where(Contact.phone_country == country)
    suppressed = exists().where(SuppressionEntry.application_id == Contact.application_id,
                                SuppressionEntry.channel == "voice", SuppressionEntry.value_hash == Contact.phone_hash)
    steps = [("no_phone", Contact.phone.is_(None)), ("unsubscribed", Contact.voice_unsubscribed_at.is_not(None)),
             ("blocked", Contact.status == "blocked"), ("suppressed", suppressed),
             ("no_consent", Contact.voice_consent.is_not(True))]
    if country:
        steps.append(("other_country", func.coalesce(Contact.phone_country, "") != country))
    excluded, prior = {}, []
    for key, cond in steps:
        excluded[key] = count(db, base.where(cond, *[not_(p) for p in prior]))
        prior.append(cond)
    return Estimate(matched=matched, eligible=count(db, eligible_q), excluded=excluded)


def draft_snapshot(db: Session, c: VoiceCampaign) -> dict | None:
    country = campaign_country(db, c)
    caller = _Caller(country, caller_kinds(country, c.category)[0])
    if is_ai(db, c):
        agent = agent_of(db, c)
        if agent is None:
            return None
        from app.services.voice.ai_results import _business_name

        return script.snapshot_agent(agent, caller, c, _business_name(db, c))
    audio = audio_of(db, c)
    if audio is None:
        return None
    snap = {**script.snapshot_message(audio, caller, c), "message_type": message_type_of(db, c)}
    if country == "AE":  # the UAE recording notice names the business
        from app.services.voice.ai_results import _business_name

        snap["business_name"] = _business_name(db, c)
    return snap


def cost_estimate(recipients: int, seconds: float, country: str | None, ai: bool = False) -> dict:
    """AI-agent calls: the AI per-minute rate x the expected minutes per answered call."""
    unit, currency = rules.price_per_minute(country, ai=ai)
    minutes = settings.AI_CALL_EXPECTED_MINUTES if ai else rules.billable_minutes(int(round(seconds)))
    return {"per_minute": unit, "currency": currency, "minutes_per_call": minutes, "ai": ai,
            "total": round(recipients * minutes * unit, 2)}


# ------------------------------------------------------------------ readiness


def _check(key: str, label: str, ok: bool, detail: str | None = None, **kw) -> ReadinessCheck:
    return rd.check(key, label, ok, detail, **kw)


def country_of(db: Session, ctx, c: VoiceCampaign) -> tuple[None, str | None]:
    """(None, the country calls go to). The first value is kept for older callers: there is no caller choice."""
    return None, campaign_country(db, c)


def calling_window(db: Session, ctx, c: VoiceCampaign, country: str | None) -> dict:
    """The hours calls go out, why, and how many would wait if the campaign started now."""
    quiet = rd.quiet_hours(db, c.application_id)
    legal = rules.window_for(country) if c.category == "promotional" else None
    window = rd.effective_window(legal, quiet)
    if legal and country:
        window["reason"] = window["reason"].replace(
            "Legal calling window", f"Legal calling window in {COUNTRY_NAME.get(country, country)}")
    out = {"window": window, "waiting": 0, "next_window_at": None, "timezone": None}
    try:
        q = base_query(ctx).where(audience_condition(db, ctx, c.audience or {}), eligibility_condition("voice"))
    except ValidationFailed:
        return out
    if country:
        q = q.where(Contact.phone_country == country)
    app_tz = ctx.application.timezone if ctx.application else None
    w = rd.waiting_estimate(db, q, app_tz,
                            lambda now, tz: rules.next_allowed(now, tz, country, c.category, quiet))
    return {**out, **(w or {})}


def readiness(db: Session, ctx, c: VoiceCampaign) -> tuple[list[ReadinessCheck], Estimate | None]:
    checks: list[ReadinessCheck] = []
    _, country = country_of(db, ctx, c)
    ai_call = is_ai(db, c)
    from app.services.voice.numbers import availability

    what = {"promotional": "promotional", "transactional": "transactional", "service": "service"}[c.category]
    blocked = uae.voice_blocked(country)
    if blocked:
        # Kill switch (VOICE_UAE_ENABLED): UAE calls are "coming soon".
        checks.append(_check("uae_available", "Calls to the UAE", False, blocked, step="setup",
                             meta={"rules": list(UAE_RULES)}))
    else:
        problem = availability(db, country, c.category, ai=ai_call)
        checks.append(_check("calling", f"Signalcraft can place {what} calls to {COUNTRY_NAME.get(country, 'this market')}",
                             problem is None, problem, step="setup",
                             meta={"note": "Calls come from a Signalcraft-managed number"}))
    if country == "IN":
        reg = dlt_row(db, c.application_id)
        checks.append(_check("registration", "TRAI DLT entity registration",
                             bool(reg and reg.principal_entity_id and reg.attested_at),
                             "Indian calls need your business registered on a DLT portal (the same registration "
                             "as SMS). Add and confirm your Principal Entity (PE) ID.",
                             action_url=rd.app_url(ctx, "/voice/registration"), action_label="DLT registration"))
    audio = None if ai_call else audio_of(db, c)
    if ai_call:
        agent = agent_of(db, c)
        if agent is None:
            checks.append(_check("message", "AI agent", False, "Choose the AI agent that will hold the conversation",
                                 step="message", action_url=rd.app_url(ctx, "/voice/agents"),
                                 action_label="AI agents"))
        else:
            checks.append(_check("message", "AI agent", agent.status == "active",
                                 f"Activate “{agent.name}” before calling with it", step="message",
                                 action_url=rd.app_url(ctx, f"/voice/agents/{agent.id}"), action_label="Open agent"))
    else:
        checks.append(_check("message", "Message", audio is not None, "Choose a recording or a text-to-speech script",
                             step="message"))
    if audio is not None and audio.kind == "tts":
        issues = render.check([audio.tts_text, c.intro_text], custom_keys(db, c.application_id))
        checks.append(_check("personalisation", "Personalisation fields", issues.ok,
                             "Unknown fields: " + ", ".join(issues.unknown + issues.malformed), step="message"))
    if c.category == "promotional" and country == "US" and not ai_call:
        checks.append(_check("identification", "Business identified at the start", bool((c.intro_text or "").strip()),
                             "US prerecorded marketing calls must say who is calling at the start (TCPA)",
                             step="message"))
        checks.append(_check("opt_out", "Press-9 opt-out", c.opt_out_keypress,
                             "US prerecorded marketing calls must offer an automated opt-out (TCPA)", step="message"))
    if ai_call and settings.COMMUNICATION_MODE == "live" and not settings.ANTHROPIC_API_KEY:
        checks.append(_check("ai_service", "AI service connected", False,
                             "The platform's AI service isn't configured yet (ANTHROPIC_API_KEY).", step="message"))
    if country:
        consented = count(db, base_query(ctx).where(eligibility_condition("voice"), Contact.phone_country == country))
        checks.append(_check(
            "consent", "Contacts with call consent" + (" (TCPA)" if country == "US" else ""), consented > 0,
            f"No contact with a number in {COUNTRY_NAME[country]} has agreed to marketing calls yet. Import "
            "contacts with their consent, or record consent on each contact.",
            action_url=rd.app_url(ctx, "/audience/import"), action_label="Import contacts"))
    est = None
    try:
        est = estimate(db, ctx, c.audience or {}, country)
        detail = "Choose who should be called" if not est.matched else (
            f"No one in this audience has voice consent and a number in {COUNTRY_NAME.get(country, country)}"
            if country else "No one in this audience can receive marketing calls")
        checks.append(_check("audience", "Audience with reachable contacts", est.eligible > 0, detail,
                             step="audience"))
    except ValidationFailed as exc:
        checks.append(_check("audience", "Audience with reachable contacts", False, exc.message, step="audience"))
    if est and est.eligible > 0:
        snap = draft_snapshot(db, c)
        if snap:
            cost = cost_estimate(est.eligible, script.estimated_seconds(snap), country, ai=ai_call)
            checks.append(rd.wallet_check(db, ctx, cost["total"], cost["currency"]))
    return checks, est


def _require_ready(db: Session, ctx, c: VoiceCampaign) -> None:
    failing = [ch for ch in readiness(db, ctx, c)[0] if not ch.ok]
    if failing:
        raise ValidationFailed("This campaign is not ready to call", code="CAMPAIGN_NOT_READY",
                               details=[ch.model_dump() for ch in failing])


# ------------------------------------------------------------------ CRUD


def list_campaigns(db: Session, ctx: AppContext, params: PageParams, status: str | None, search: str | None
                   ) -> Page[CampaignListItem]:
    ctx.require(Perm.CAMPAIGNS_READ)
    q = select(VoiceCampaign).where(*_visible(ctx))
    if status:
        q = q.where(VoiceCampaign.status == status)
    if search:
        q = q.where(func.lower(VoiceCampaign.name).like(f"%{search.strip().lower()}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(VoiceCampaign.updated_at.desc()).offset(params.offset).limit(params.page_size)))
    stats = stats_for(db, [r.id for r in rows])
    items = []
    for r in rows:
        it = CampaignListItem.model_validate(r)
        it.stats = stats.get(r.id)
        items.append(it)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def create_campaign(db: Session, ctx: AppContext, data: CampaignCreate) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = VoiceCampaign(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                      description=data.description, category=data.category, created_by_id=ctx.user.id,
                      audience=initial_audience(db, ctx, data.audience), opt_out_keypress=True,
                      intro_text=f"Hello, this is a call from {business_name(db, ctx)}.", max_attempts=2,
                      retry_delay_minutes=60, snapshot={}, excluded={})
    if data.audio_id:
        from app.services.voice.library import audio_row

        audio = audio_row(db, ctx, data.audio_id)
        c.audio_id, c.message_type = audio.id, "tts" if audio.kind == "tts" else "audio"
    if data.agent_id:
        from app.services.voice.agents import agent_row

        c.agent_id, c.message_type = agent_row(db, ctx, data.agent_id).id, "ai_agent"
    db.add(c)
    db.flush()
    _audit(db, ctx, "created", c)
    return c


def get_campaign(db: Session, ctx: AppContext, campaign_id: str) -> CampaignOut:
    ctx.require(Perm.CAMPAIGNS_READ)
    return to_out(db, _get(db, ctx, campaign_id))


def update_campaign(db: Session, ctx: AppContext, campaign_id: str, data: CampaignUpdate) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    if c.status not in EDITABLE:
        raise Conflict("Only draft campaigns can be edited. Unschedule it first.", code="NOT_EDITABLE")
    changes = data.model_dump(exclude_unset=True)
    if changes.get("audio_id"):
        from app.services.voice.library import audio_row

        audio = audio_row(db, ctx, changes["audio_id"])
        if "message_type" not in changes:
            changes["message_type"] = "tts" if audio.kind == "tts" else "audio"
    if changes.get("agent_id"):
        from app.services.voice.agents import agent_row

        agent_row(db, ctx, changes["agent_id"])
        changes.setdefault("message_type", "ai_agent")
    if "intro_text" in changes and changes["intro_text"]:
        issues = render.check([changes["intro_text"]], custom_keys(db, ctx.application_id))
        if not issues.ok:
            raise ValidationFailed("Fix the personalisation fields in the introduction", code="INVALID_VARIABLES")
    if changes.get("audience") is not None:
        audience_condition(db, ctx, changes["audience"])
    for k, v in changes.items():
        if k in ("name", "category", "opt_out_keypress", "max_attempts", "retry_delay_minutes",
                 "message_type") and v is None:
            continue
        setattr(c, k, v)
    return c


def delete_campaign(db: Session, ctx: AppContext, campaign_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    if c.status != "draft":
        raise Conflict("Only draft campaigns can be deleted", code="NOT_DELETABLE")
    db.delete(c)
    _audit(db, ctx, "deleted", c)


def duplicate_campaign(db: Session, ctx: AppContext, campaign_id: str) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    s = _get(db, ctx, campaign_id)
    c = VoiceCampaign(organization_id=ctx.organization_id, application_id=ctx.application_id,
                      name=f"{s.name} (copy)"[:160], description=s.description, category=s.category,
                      audio_id=s.audio_id, intro_text=s.intro_text,
                      message_type=message_type_of(db, s), agent_id=s.agent_id,
                      opt_out_keypress=s.opt_out_keypress, max_attempts=s.max_attempts,
                      retry_delay_minutes=s.retry_delay_minutes, audience=dict(s.audience or {}),
                      created_by_id=ctx.user.id, snapshot={}, excluded={})
    db.add(c)
    db.flush()
    return c


# ------------------------------------------------------------------ preview & test


def preview(db: Session, ctx: AppContext, campaign_id: str, contact_id: str | None) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    snap = draft_snapshot(db, c)
    if snap is None:
        return {"steps": [], "seconds": 0, "contact_label": None}
    contact = None
    if contact_id:
        contact = db.scalar(select(Contact).where(Contact.id == contact_id, Contact.application_id == ctx.application_id))
        if contact is None:
            raise NotFound("Contact not found")
    sc = script.build(snap, contact, None, sample=contact is None)
    if snap.get("message_type") == "ai_agent":
        return {"steps": [{"kind": "say", "text": sc.steps[0].text, "url": None},
                          {"kind": "agent", "text": f"Then “{snap['agent_name']}” holds the conversation.",
                           "url": None}],
                "seconds": script.estimated_seconds(snap), "language": snap["language"], "voice": snap["voice"],
                "ai_agent": True,
                "contact_label": (contact.full_name or contact.phone or "Contact") if contact else
                "Sample contact (Asha Rao)"}
    return {"steps": script.as_text(sc), "seconds": script.estimated_seconds(snap), "language": snap["language"],
            "voice": snap["voice"],
            "contact_label": (contact.full_name or contact.phone or "Contact") if contact else "Sample contact (Asha Rao)"}


def test_call(db: Session, ctx: AppContext, campaign_id: str, data: TestCall) -> dict:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    country = campaign_country(db, c)
    snap = draft_snapshot(db, c)
    if snap is None:
        raise ValidationFailed("Choose a message before placing a test call", code="INCOMPLETE")
    if snap.get("message_type") == "ai_agent":
        raise ValidationFailed("Try AI agents with “Test & train” on the agent's page. Live AI calls are "
                               "placed from a running campaign.", code="AI_TEST_CALL_UNSUPPORTED")
    from app.services.voice.numbers import availability, pick_caller

    problem = availability(db, country, c.category)
    if problem:
        raise ValidationFailed(problem, code="CALLING_UNAVAILABLE")
    pname = "simulation"
    results = []
    for raw in data.phones:
        parsed = parse_phone(raw, country)
        if parsed is None:
            results.append({"phone": raw, "accepted": False, "error": "Not a valid phone number"})
            continue
        if parsed.country != country:
            results.append({"phone": parsed.e164, "accepted": False,
                            "error": f"This campaign calls numbers in {COUNTRY_NAME.get(country, country)}"})
            continue
        pn = pick_caller(db, country=country, kind=caller_kinds(country, c.category), contact_id=parsed.e164)
        if pn is None:
            results.append({"phone": parsed.e164, "accepted": False, "error": "No Signalcraft number is available"})
            continue
        provider, pname = provider_for(pn.provider)
        res = provider.place(OutboundCall(to=parsed.e164, caller_id=pn.number,
                                          script=script.build(snap, None, None, sample=True)))
        results.append({"phone": parsed.e164, "accepted": res.accepted, "error": res.error_message,
                        "from_number": pn.number})
    _audit(db, ctx, "test_call", c, {"count": len(data.phones)})
    return {"provider": pname, "results": results}


# ------------------------------------------------------------------ lifecycle


def _audit(db: Session, ctx, action: str, c: VoiceCampaign, meta: dict | None = None) -> None:
    audit_service.record(db, f"voice_campaign.{action}", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="voice_campaign", target_id=c.id, summary=c.name, meta=meta)


def _dispatch(task_name: str, campaign_id: str) -> None:
    from app.tasks import voice as voice_tasks
    from app.workers.dispatch import dispatch

    dispatch(getattr(voice_tasks, task_name), campaign_id)


def schedule(db: Session, ctx: AppContext, campaign_id: str, body: ScheduleRequest) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("draft", "scheduled"):
        raise Conflict("Only draft campaigns can be scheduled")
    try:
        tz = ZoneInfo(body.timezone)
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed("Unknown timezone") from exc
    when = body.scheduled_at if body.scheduled_at.tzinfo else body.scheduled_at.replace(tzinfo=tz)
    now = utcnow()
    if when < now + timedelta(minutes=2):
        raise ValidationFailed("Schedule at least a few minutes in the future", code="SCHEDULE_IN_PAST")
    if when > now + timedelta(days=365):
        raise ValidationFailed("Campaigns can be scheduled up to one year ahead")
    _require_ready(db, ctx, c)
    c.status, c.scheduled_at, c.schedule_timezone = "scheduled", when, body.timezone
    _audit(db, ctx, "scheduled", c, {"scheduled_at": when.isoformat(), "timezone": body.timezone})
    return c


def unschedule(db: Session, ctx: AppContext, campaign_id: str) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status != "scheduled":
        raise Conflict("This campaign is not scheduled")
    c.status, c.scheduled_at = "draft", None
    _audit(db, ctx, "unscheduled", c)
    return c


def send_now(db: Session, ctx: AppContext, campaign_id: str) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("draft", "scheduled"):
        raise Conflict("This campaign has already started", code="ALREADY_LAUNCHED")
    _require_ready(db, ctx, c)
    c.status, c.scheduled_at = "queued", None
    _audit(db, ctx, "launched", c)
    db.commit()
    _dispatch("launch_voice_campaign", c.id)
    db.refresh(c)
    return c


def pause(db: Session, ctx: AppContext, campaign_id: str) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("queued", "sending"):
        raise Conflict("Only running campaigns can be paused")
    c.status = "paused"
    _audit(db, ctx, "paused", c)
    return c


def resume(db: Session, ctx: AppContext, campaign_id: str) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status != "paused":
        raise Conflict("Only paused campaigns can be resumed")
    c.status = "sending" if c.launched_at else "queued"
    _audit(db, ctx, "resumed", c)
    db.commit()
    _dispatch("continue_voice_campaign" if c.launched_at else "launch_voice_campaign", c.id)
    db.refresh(c)
    return c


def cancel(db: Session, ctx: AppContext, campaign_id: str) -> VoiceCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ACTIVE:
        raise Conflict("Only queued, running or paused campaigns can be cancelled")
    c.status, c.completed_at = "cancelled", utcnow()
    db.execute(update(VoiceCall).where(VoiceCall.campaign_id == c.id, VoiceCall.status.in_(PENDING))
               .values(status="skipped", error_code="cancelled", error_message="Campaign was cancelled",
                       updated_at=utcnow()))
    _audit(db, ctx, "cancelled", c)
    return c


# ------------------------------------------------------------------ reporting


def report(db: Session, ctx: AppContext, campaign_id: str) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    st = stats_for(db, [c.id]).get(c.id, Stats())
    finished = st.answered + st.voicemail + st.no_answer + st.busy + st.failed

    def rate(n, d):
        return round(100 * n / d, 2) if d else None

    # Only finished calls; a call waiting for its retry is not "not reached" yet.
    times = db.execute(select(VoiceCall.ended_at, VoiceCall.status).where(
        VoiceCall.campaign_id == c.id, VoiceCall.ended_at.is_not(None),
        VoiceCall.status.in_(("completed", "voicemail", "no_answer", "busy", "failed")))).all()
    start = c.launched_at or c.created_at
    span = max([t for t, _ in times] + [start]) - start
    hourly = span <= timedelta(hours=72)
    buckets: Counter = Counter()
    for t, status in times:
        b = t.replace(minute=0, second=0, microsecond=0) if hourly else t.replace(hour=0, minute=0, second=0,
                                                                                  microsecond=0)
        buckets[(b, "answered" if status in ANSWERED else "unanswered")] += 1
    keys = sorted({b for b, _ in buckets})
    reasons = db.execute(select(VoiceCall.status, VoiceCall.error_code, VoiceCall.error_message, func.count())
                         .where(VoiceCall.campaign_id == c.id, VoiceCall.status.in_(("failed", "skipped")))
                         .group_by(VoiceCall.status, VoiceCall.error_code, VoiceCall.error_message)
                         .order_by(func.count().desc()).limit(10)).all()
    waiting = db.execute(select(VoiceCall.deferred_reason, func.min(VoiceCall.next_attempt_at), func.count())
                         .where(VoiceCall.campaign_id == c.id, VoiceCall.status.in_(PENDING),
                                VoiceCall.next_attempt_at.is_not(None))
                         .group_by(VoiceCall.deferred_reason)).all()
    answered_total = st.answered + st.voicemail
    return {
        "campaign": to_out(db, c).model_dump(mode="json"),
        "stats": st.model_dump(),
        "rates": {"answer_rate": rate(st.answered, finished), "reach_rate": rate(answered_total, finished),
                  "opt_out_rate": rate(st.opted_out, st.answered),
                  "average_seconds": round(st.talk_seconds / answered_total, 1) if answered_total else None},
        "outcomes": {"answered": st.answered, "voicemail": st.voicemail, "no_answer": st.no_answer, "busy": st.busy,
                     "failed": st.failed},
        "timeline": {"granularity": "hour" if hourly else "day",
                     "points": [{"at": k.isoformat(), "answered": buckets[(k, "answered")],
                                 "unanswered": buckets[(k, "unanswered")]} for k in keys]},
        "failure_reasons": [{"status": s, "code": code, "message": msg, "count": n} for s, code, msg, n in reasons],
        "waiting": [{"reason": r or "retry", "next_attempt_at": at.isoformat() if at else None, "count": n}
                    for r, at, n in waiting],
        "simulated": c.provider == "simulation",
    }


def _filter_calls(q, status: str | None):
    if status == "opted_out":  # pressed 9
        return q.where(VoiceCall.opted_out.is_(True))
    if status == "in_progress":
        return q.where(VoiceCall.status.in_(IN_FLIGHT))
    if status == "answered_any":  # a person or voicemail picked up
        return q.where(VoiceCall.status.in_(ANSWERED))
    if status == "not_answered":
        return q.where(VoiceCall.status.in_(("no_answer", "busy", "failed")))
    if status:
        return q.where(VoiceCall.status == status)
    return q


def recipient_ids(db: Session, ctx: AppContext, campaign_id: str, status: str | None) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    return capped_ids(db, _filter_calls(select(VoiceCall.contact_id).where(
        VoiceCall.campaign_id == c.id, VoiceCall.contact_id.is_not(None)), status))


def list_calls(db: Session, ctx: AppContext, campaign_id: str, params: PageParams, status: str | None,
               search: str | None) -> Page[CallOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    q = _filter_calls(select(VoiceCall).where(VoiceCall.campaign_id == c.id), status)
    if search:
        digits = "".join(ch for ch in search if ch.isdigit())
        if digits:
            q = q.where(VoiceCall.to_phone.like(f"%{digits}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(VoiceCall.created_at, VoiceCall.id).offset(params.offset)
                           .limit(params.page_size)))
    names = {x.id: x.full_name for x in db.scalars(select(Contact).where(
        Contact.id.in_([r.contact_id for r in rows if r.contact_id])))} if rows else {}
    items = []
    for r in rows:
        it = CallOut.model_validate(r)
        it.contact_name = names.get(r.contact_id)
        it.has_transcript = bool(r.transcript)
        items.append(it)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def call_detail(db: Session, ctx: AppContext, campaign_id: str, call_id: str) -> dict:
    """One call with its AI conversation (transcript, summary and what was captured)."""
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    call = db.scalar(select(VoiceCall).where(VoiceCall.id == call_id, VoiceCall.campaign_id == c.id))
    if call is None:
        raise NotFound("Call not found")
    contact = db.get(Contact, call.contact_id) if call.contact_id else None
    agent = (c.snapshot or {}).get("agent") or {}
    labels = {f.get("key"): f for f in agent.get("outcome_fields") or []}
    outcomes = call.ai_outcomes or {}
    out = CallOut.model_validate(call).model_dump(mode="json")
    out.update({
        "contact_name": contact.full_name if contact else None, "has_transcript": bool(call.transcript),
        "campaign": {"id": c.id, "name": c.name}, "transcript": call.transcript or [],
        "agent": {"id": agent.get("id"), "name": agent.get("name"), "version": agent.get("version")} if agent else None,
        "ai_outcomes": [{"key": k, "label": (labels.get(k) or {}).get("label", k),
                         "type": (labels.get(k) or {}).get("type", "text"), "value": v}
                        for k, v in outcomes.items() if not k.startswith("_")],
        "callback_requested_at": outcomes.get("_callback_requested_at"),
        "do_not_call": bool(outcomes.get("_do_not_call")), "simulated": bool(outcomes.get("_simulated")),
    })
    return out


def overview(db: Session, ctx: AppContext) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    since = utcnow() - timedelta(days=30)
    by_status = dict(db.execute(select(VoiceCampaign.status, func.count()).where(
        *_visible(ctx)).group_by(VoiceCampaign.status)).all())
    launched = list(db.scalars(select(VoiceCampaign).where(*_visible(ctx),
                                                           VoiceCampaign.launched_at >= since)))
    stats = stats_for(db, [c.id for c in launched])
    agg = Stats()
    for s in stats.values():
        for k in Stats.model_fields:
            setattr(agg, k, getattr(agg, k) + getattr(s, k))
    spend: dict[str, float] = {}
    for c in launched:
        if c.currency and c.id in stats:
            spend[c.currency] = round(spend.get(c.currency, 0) + stats[c.id].cost, 2)
    finished = agg.answered + agg.voicemail + agg.no_answer + agg.busy + agg.failed
    recent = list(db.scalars(select(VoiceCampaign).where(*_visible(ctx))
                             .order_by(VoiceCampaign.updated_at.desc()).limit(5)))
    rs = stats_for(db, [r.id for r in recent])
    upcoming = list(db.scalars(select(VoiceCampaign).where(*_visible(ctx),
                                                           VoiceCampaign.status == "scheduled")
                               .order_by(VoiceCampaign.scheduled_at).limit(5)))
    agents = dict(db.execute(select(VoiceAgent.status, func.count()).where(
        VoiceAgent.application_id == ctx.application_id).group_by(VoiceAgent.status)).all())
    audio = db.scalar(select(func.count()).select_from(VoiceAudio).where(VoiceAudio.application_id == ctx.application_id))
    return {
        "campaigns_by_status": by_status,
        "last_30_days": {**agg.model_dump(), "campaigns": len(launched), "spend": spend,
                         "answer_rate": round(100 * agg.answered / finished, 1) if finished else None},
        "recent": [{**CampaignListItem.model_validate(r).model_dump(mode="json"),
                    "stats": (rs.get(r.id) or Stats()).model_dump()} for r in recent],
        "upcoming": [CampaignListItem.model_validate(r).model_dump(mode="json") for r in upcoming],
        "agents": agents,
        "audio_count": audio or 0,
        "setup": _setup_facts(db, ctx),
    }


def _setup_facts(db: Session, ctx) -> dict:
    reg = dlt_row(db, ctx.application_id)
    country = rd.effective_country(ctx, None)
    consented = count(db, base_query(ctx).where(eligibility_condition("voice"),
                                                *([Contact.phone_country == country] if country else [])))
    blocked = uae.voice_blocked(country)
    return {"default_country": country, "dlt_registered": bool(reg and reg.principal_entity_id and reg.attested_at),
            "consented": consented,
            # UAE: "coming soon" while VOICE_UAE_ENABLED is off, with the rules that will apply.
            "coming_soon": blocked, "market_rules": list(UAE_RULES) if country == "AE" else []}

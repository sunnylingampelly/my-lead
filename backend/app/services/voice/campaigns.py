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
from app.models.voice import VoiceAudio, VoiceCall, VoiceCallerId, VoiceCampaign
from app.providers.voice.base import OutboundCall
from app.providers.voice.factory import live_credentials_missing, provider_for
from app.schemas.common import Page, PageParams
from app.schemas.email import Estimate, ReadinessCheck, ScheduleRequest
from app.schemas.voice import CallOut, CampaignCreate, CampaignListItem, CampaignOut, CampaignUpdate, Stats, TestCall
from app.services import audit_service
from app.services.audience.query import base_query, count, eligibility_condition
from app.services.email import render
from app.services.email.campaigns import audience_condition, custom_keys
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
COUNTRY_NAME = {"IN": "India", "US": "the United States"}



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


def caller_of(db: Session, c: VoiceCampaign) -> VoiceCallerId | None:
    x = db.get(VoiceCallerId, c.caller_ref) if c.caller_ref else None
    return x if x is not None and x.application_id == c.application_id else None


def audio_of(db: Session, c: VoiceCampaign) -> VoiceAudio | None:
    a = db.get(VoiceAudio, c.audio_id) if c.audio_id else None
    return a if a is not None and a.application_id == c.application_id else None


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
    caller, audio = caller_of(db, c), audio_of(db, c)
    if audio is None:
        return None
    if caller is None:
        caller = VoiceCallerId(number="", country="", kind="", provider="simulation")
    return script.snapshot_message(audio, caller, c)


def cost_estimate(recipients: int, seconds: float, country: str | None) -> dict:
    unit, currency = rules.price_per_minute(country)
    minutes = rules.billable_minutes(int(round(seconds)))
    return {"per_minute": unit, "currency": currency, "minutes_per_call": minutes,
            "total": round(recipients * minutes * unit, 2)}


# ------------------------------------------------------------------ readiness


def _check(key: str, label: str, ok: bool, detail: str | None = None) -> ReadinessCheck:
    return ReadinessCheck(key=key, label=label, ok=ok, detail=None if ok else detail)


def readiness(db: Session, ctx, c: VoiceCampaign) -> tuple[list[ReadinessCheck], Estimate | None]:
    checks: list[ReadinessCheck] = []
    caller = caller_of(db, c)
    if caller is None:
        checks.append(_check("caller", "Approved caller ID", False, "Choose a caller ID"))
    else:
        checks.append(_check("caller", "Approved caller ID", caller.status == "active",
                             f"Confirm that {caller.number} is yours and registered (Caller IDs page)"))
    country = caller.country if caller else None
    if caller and country == "IN":
        reg = dlt_row(db, c.application_id)
        checks.append(_check("registration", "TRAI DLT entity registration",
                             bool(reg and reg.principal_entity_id and reg.attested_at),
                             "Add and confirm your DLT Principal Entity ID (SMS → DLT & 10DLC)"))
        checks.append(_check("category", "Number series matches call type",
                             rules.caller_fits_category(country, caller.kind, c.category),
                             "Promotional calls use a 140-series number; service and transactional calls use a "
                             "160-series number"))
    audio = audio_of(db, c)
    checks.append(_check("message", "Message", audio is not None, "Choose a recording or a text-to-speech script"))
    if audio is not None and audio.kind == "tts":
        issues = render.check([audio.tts_text, c.intro_text], custom_keys(db, c.application_id))
        checks.append(_check("personalisation", "Personalisation fields", issues.ok,
                             "Unknown fields: " + ", ".join(issues.unknown + issues.malformed)))
    if c.category == "promotional" and country == "US":
        checks.append(_check("identification", "Business identified at the start", bool((c.intro_text or "").strip()),
                             "US prerecorded marketing calls must say who is calling at the start (TCPA)"))
        checks.append(_check("opt_out", "Press-9 opt-out", c.opt_out_keypress,
                             "US prerecorded marketing calls must offer an automated opt-out (TCPA)"))
    if settings.COMMUNICATION_MODE == "live" and caller:
        missing = live_credentials_missing(caller.provider)
        checks.append(_check("provider", "Voice provider connected", missing is None, missing))
    est = None
    try:
        est = estimate(db, ctx, c.audience or {}, country)
        detail = "Choose an audience" if not est.matched else (
            f"No one in this audience has voice consent and a number in {COUNTRY_NAME.get(country, country)}"
            if country else "No one in this audience can receive marketing calls")
        checks.append(_check("audience", "Audience with reachable contacts", est.eligible > 0, detail))
    except ValidationFailed as exc:
        checks.append(_check("audience", "Audience with reachable contacts", False, exc.message))
    if est and est.eligible > 0 and caller:
        from app.services.billing import wallet as wl

        snap = draft_snapshot(db, c)
        if snap:
            cost = cost_estimate(est.eligible, script.estimated_seconds(snap), country)
            checks.append(wl.wallet_check(db, c.organization_id, cost["total"], cost["currency"]))
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
                      audience={"all": False, "list_ids": [], "segment_ids": []}, opt_out_keypress=True,
                      intro_text=f"Hello, this is a call from {business_name(db, ctx)}.", max_attempts=2,
                      retry_delay_minutes=60, snapshot={}, excluded={})
    default = db.scalar(select(VoiceCallerId).where(VoiceCallerId.application_id == ctx.application_id,
                                                    VoiceCallerId.is_default.is_(True)))
    if default:
        c.caller_ref = default.id
    if data.audio_id:
        from app.services.voice.library import audio_row

        c.audio_id = audio_row(db, ctx, data.audio_id).id
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
    if changes.get("caller_ref"):
        from app.services.voice.library import caller_row

        caller_row(db, ctx, changes["caller_ref"])
    if changes.get("audio_id"):
        from app.services.voice.library import audio_row

        audio_row(db, ctx, changes["audio_id"])
    if "intro_text" in changes and changes["intro_text"]:
        issues = render.check([changes["intro_text"]], custom_keys(db, ctx.application_id))
        if not issues.ok:
            raise ValidationFailed("Fix the personalisation fields in the introduction", code="INVALID_VARIABLES")
    if changes.get("audience") is not None:
        audience_condition(db, ctx, changes["audience"])
    for k, v in changes.items():
        if k in ("name", "category", "opt_out_keypress", "max_attempts", "retry_delay_minutes") and v is None:
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
                      caller_ref=s.caller_ref, audio_id=s.audio_id, intro_text=s.intro_text,
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
    return {"steps": script.as_text(sc), "seconds": script.estimated_seconds(snap), "language": snap["language"],
            "voice": snap["voice"],
            "contact_label": (contact.full_name or contact.phone or "Contact") if contact else "Sample contact (Asha Rao)"}


def test_call(db: Session, ctx: AppContext, campaign_id: str, data: TestCall) -> dict:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    caller = caller_of(db, c)
    if caller is None or caller.status != "active":
        raise ValidationFailed("Choose a confirmed caller ID before placing a test call", code="CALLER_NOT_ACTIVE")
    snap = draft_snapshot(db, c)
    if snap is None:
        raise ValidationFailed("Choose a message before placing a test call", code="INCOMPLETE")
    provider, pname = provider_for(caller.provider)
    results = []
    for raw in data.phones:
        parsed = parse_phone(raw, caller.country)
        if parsed is None:
            results.append({"phone": raw, "accepted": False, "error": "Not a valid phone number"})
            continue
        if parsed.country != caller.country:
            results.append({"phone": parsed.e164, "accepted": False,
                            "error": f"{caller.number} can only call numbers in {COUNTRY_NAME[caller.country]}"})
            continue
        res = provider.place(OutboundCall(to=parsed.e164, caller_id=caller.number,
                                          script=script.build(snap, None, None, sample=True)))
        results.append({"phone": parsed.e164, "accepted": res.accepted, "error": res.error_message})
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


def list_calls(db: Session, ctx: AppContext, campaign_id: str, params: PageParams, status: str | None,
               search: str | None) -> Page[CallOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    q = select(VoiceCall).where(VoiceCall.campaign_id == c.id)
    if status == "opted_out":
        q = q.where(VoiceCall.opted_out.is_(True))
    elif status == "in_progress":
        q = q.where(VoiceCall.status.in_(IN_FLIGHT))
    elif status:
        q = q.where(VoiceCall.status == status)
    if search:
        digits = "".join(ch for ch in search if ch.isdigit())
        if digits:
            q = q.where(VoiceCall.to_phone.like(f"%{digits}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(VoiceCall.created_at, VoiceCall.id).offset(params.offset).limit(params.page_size))
    return Page(items=[CallOut.model_validate(r) for r in rows], total=total, page=params.page,
                page_size=params.page_size)


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
    callers = dict(db.execute(select(VoiceCallerId.status, func.count()).where(
        VoiceCallerId.application_id == ctx.application_id).group_by(VoiceCallerId.status)).all())
    audio = db.scalar(select(func.count()).select_from(VoiceAudio).where(VoiceAudio.application_id == ctx.application_id))
    return {
        "campaigns_by_status": by_status,
        "last_30_days": {**agg.model_dump(), "campaigns": len(launched), "spend": spend,
                         "answer_rate": round(100 * agg.answered / finished, 1) if finished else None},
        "recent": [{**CampaignListItem.model_validate(r).model_dump(mode="json"),
                    "stats": (rs.get(r.id) or Stats()).model_dump()} for r in recent],
        "upcoming": [CampaignListItem.model_validate(r).model_dump(mode="json") for r in upcoming],
        "callers": callers,
        "audio_count": audio or 0,
    }

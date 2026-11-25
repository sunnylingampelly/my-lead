"""Email campaign lifecycle: draft → scheduled/queued → sending ⇄ paused → completed | cancelled | failed."""
from collections import Counter
from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import case, exists, false, func, not_, or_, select, true, update
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import (
    ApplicationSettings,
    Contact,
    ContactAttributeDefinition,
    ContactList,
    ContactListMember,
    Segment,
    SuppressionEntry,
)
from app.models.email import EmailCampaign, EmailEvent, EmailMessage, EmailSender
from app.providers.email.base import OutboundEmail
from app.schemas.common import Page, PageParams
from app.schemas.email import (
    MAX_AUDIENCE_CONTACT_IDS,
    CampaignCreate,
    CampaignListItem,
    CampaignOut,
    CampaignStats,
    CampaignUpdate,
    Estimate,
    MessageOut,
    PreviewOut,
    PreviewRequest,
    ReadinessCheck,
    ScheduleRequest,
    TestSendRequest,
    without_design,
)
from app.services import audit_service
from app.services.audience.query import base_query, count, eligibility_condition
from app.services.audience.segments import compile_rules
from app.services.email import render
from app.services.email.templates import _get as get_template_row
from app.services.regions import profile_for
from app.services.tenancy import AppContext
from app.utils.time import utcnow

EDITABLE = ("draft",)
ACTIVE = ("queued", "sending", "paused")
MAX_DESIGN_BYTES = 8_000_000
MAX_RECIPIENT_IDS = 5000


# ------------------------------------------------------------------ helpers


def _visible(ctx) -> tuple:
    """Campaigns shown in lists and overviews: this application's, without hidden automation steps."""
    return (EmailCampaign.application_id == ctx.application_id, EmailCampaign.status != "automation")

def _get(db: Session, ctx, campaign_id: str, lock: bool = False) -> EmailCampaign:
    q = select(EmailCampaign).where(EmailCampaign.id == campaign_id, EmailCampaign.application_id == ctx.application_id)
    if lock:
        q = q.with_for_update()
    c = db.scalar(q)
    if c is None:
        raise NotFound("Campaign not found")
    return c


def _settings(db: Session, application_id: str) -> ApplicationSettings | None:
    return db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == application_id))


def custom_keys(db: Session, application_id: str) -> set[str]:
    return set(db.scalars(select(ContactAttributeDefinition.key).where(
        ContactAttributeDefinition.application_id == application_id)))


def stats_for(db: Session, campaign_ids: list[str]) -> dict[str, CampaignStats]:
    if not campaign_ids:
        return {}
    m = EmailMessage
    s = lambda cond: func.sum(case((cond, 1), else_=0))  # noqa: E731
    rows = db.execute(
        select(
            m.campaign_id, func.count(),
            s(m.status.in_(("queued", "sending"))),
            s(m.accepted_at.is_not(None)),
            s(m.delivered_at.is_not(None) & m.bounced_at.is_(None)),
            s(m.bounced_at.is_not(None)),
            s(m.bounce_type == "hard"),
            s(m.complained_at.is_not(None)),
            s(m.status == "failed"),
            s(m.status == "skipped"),
            s(m.first_opened_at.is_not(None)),
            func.coalesce(func.sum(m.open_count), 0),
            s(m.first_clicked_at.is_not(None)),
            func.coalesce(func.sum(m.click_count), 0),
            s(m.unsubscribed_at.is_not(None)),
        ).where(m.campaign_id.in_(campaign_ids)).group_by(m.campaign_id)
    ).all()
    out = {}
    for r in rows:
        out[r[0]] = CampaignStats(recipients=r[1], queued=r[2] or 0, sent=r[3] or 0, delivered=r[4] or 0,
                                  bounced=r[5] or 0, hard_bounced=r[6] or 0, complained=r[7] or 0, failed=r[8] or 0,
                                  skipped=r[9] or 0, unique_opens=r[10] or 0, total_opens=int(r[11] or 0),
                                  unique_clicks=r[12] or 0, total_clicks=int(r[13] or 0), unsubscribed=r[14] or 0)
    return out


def to_out(db: Session, c: EmailCampaign) -> CampaignOut:
    return without_design(CampaignOut, c, stats=stats_for(db, [c.id]).get(c.id, CampaignStats()))


# ------------------------------------------------------------------ audience

def audience_condition(db: Session, ctx, audience: dict):
    if not audience:
        return false()
    if audience.get("all"):
        return true()
    parts = []
    list_ids = list(dict.fromkeys(audience.get("list_ids") or []))
    if list_ids:
        valid = set(db.scalars(select(ContactList.id).where(ContactList.id.in_(list_ids),
                                                            ContactList.application_id == ctx.application_id)))
        if len(valid) != len(list_ids):
            raise ValidationFailed("One or more lists no longer exist", code="INVALID_AUDIENCE")
        parts.append(exists().where(ContactListMember.contact_id == Contact.id,
                                    ContactListMember.list_id.in_(list_ids)))
    for sid in dict.fromkeys(audience.get("segment_ids") or []):
        seg = db.scalar(select(Segment).where(Segment.id == sid, Segment.application_id == ctx.application_id))
        if seg is None:
            raise ValidationFailed("One or more segments no longer exist", code="INVALID_AUDIENCE")
        parts.append(compile_rules(db, ctx, seg.rules))
    contact_ids = list(dict.fromkeys(audience.get("contact_ids") or []))
    if contact_ids:
        if len(contact_ids) > MAX_AUDIENCE_CONTACT_IDS:
            raise ValidationFailed(f"Choose at most {MAX_AUDIENCE_CONTACT_IDS:,} individual contacts; use a list or "
                                   "segment for more", code="INVALID_AUDIENCE")
        found = db.scalar(select(func.count()).select_from(Contact).where(
            Contact.id.in_(contact_ids), Contact.application_id == ctx.application_id)) or 0
        if found != len(contact_ids):
            raise ValidationFailed("Some of the chosen contacts no longer exist in this application",
                                   code="INVALID_AUDIENCE")
        parts.append(Contact.id.in_(contact_ids))
    return or_(*parts) if parts else false()


def audience_chosen(audience: dict | None) -> bool:
    a = audience or {}
    return bool(a.get("all") or a.get("list_ids") or a.get("segment_ids") or a.get("contact_ids"))


def initial_audience(db: Session, ctx, audience) -> dict:
    """Audience for a new draft (e.g. created from a segment, list or a selection of contacts)."""
    if audience is None:
        return {"all": False, "list_ids": [], "segment_ids": [], "contact_ids": []}
    a = audience.model_dump() if hasattr(audience, "model_dump") else dict(audience)
    audience_condition(db, ctx, a)  # validate references
    return a


def estimate(db: Session, ctx, audience: dict) -> Estimate:
    base = base_query(ctx).where(audience_condition(db, ctx, audience))
    matched = count(db, base)
    eligible = count(db, base.where(eligibility_condition("email")))
    suppressed = exists().where(SuppressionEntry.application_id == Contact.application_id,
                                SuppressionEntry.channel == "email", SuppressionEntry.value_hash == Contact.email_hash)
    steps = [
        ("no_email", Contact.email.is_(None)),
        ("unsubscribed", Contact.email_unsubscribed_at.is_not(None)),
        ("bounced_or_blocked", Contact.status.in_(("bounced", "blocked"))),
        ("suppressed", suppressed),
        ("no_consent", Contact.email_consent.is_not(True)),
    ]
    excluded, prior = {}, []
    for key, cond in steps:
        q = base.where(cond, *[not_(p) for p in prior])
        excluded[key] = count(db, q)
        prior.append(cond)
    return Estimate(matched=matched, eligible=eligible, excluded=excluded)


# ------------------------------------------------------------------ readiness

def readiness(db: Session, ctx, c: EmailCampaign) -> tuple[list[ReadinessCheck], Estimate | None]:
    from app.services.email.readiness import app_url, check, wallet_check

    checks = []
    senders_url = app_url(ctx, "/email/senders")
    sender = db.get(EmailSender, c.sender_id) if c.sender_id else None
    if sender is not None and sender.application_id != c.application_id:
        sender = None
    sender_ok = sender is not None and sender.status == "verified"
    checks.append(check(
        "sender", "Verified sender", sender_ok,
        "Choose a sender address" if sender is None else
        f"{sender.from_email} is not verified yet. Open the confirmation email we sent to it, or resend it.",
        step="setup", action_url=senders_url, action_label="Manage senders",
        meta={"sender_id": sender.id, "status": sender.status, "from_email": sender.from_email} if sender else None))
    if sender is not None:
        from app.services.email.domains import readiness_check as domain_check

        dc = domain_check(db, ctx, sender)
        if dc is not None:
            checks.append(dc)
    checks.append(check("subject", "Subject line", bool((c.subject or "").strip()), "Add a subject", step="setup"))
    has_body = bool((c.html or "").strip() or (c.text or "").strip())
    checks.append(check("content", "Email content", has_body, "Design the email", step="content"))
    issues = render.check([c.subject, c.preheader, c.html, c.text], custom_keys(db, c.application_id))
    detail = None
    if issues.unknown:
        detail = "Unknown fields: " + ", ".join(issues.unknown)
    elif issues.malformed:
        detail = "Unsupported template syntax: " + ", ".join(issues.malformed[:3])
    checks.append(check("personalisation", "Personalisation fields", issues.ok, detail, step="content"))
    s = _settings(db, c.application_id)
    region = profile_for(ctx.application.default_country if ctx.application else None)
    need_addr = region.email_requires_postal_address
    addr_ok = bool(s and (s.business_address or "").strip()) or not need_addr
    checks.append(check(
        "postal_address", "Postal address in footer", addr_ok,
        f"{region.name} rules (CAN-SPAM) require a physical postal address in marketing email. "
        "Add it in Application settings → Compliance.",
        action_url=app_url(ctx, "/settings?tab=compliance"), action_label="Add address"))
    est = None
    try:
        est = estimate(db, ctx, c.audience or {})
        aud_ok = est.eligible > 0
        aud_detail = ("Choose who should receive this email" if not est.matched else
                      "No one in this audience can receive marketing email (they need an email address and "
                      "email consent)")
    except ValidationFailed as exc:
        aud_ok, aud_detail = False, exc.message
    checks.append(check("audience", "Audience with reachable contacts", aud_ok, aud_detail, step="audience"))
    if est and est.eligible > 0:
        from app.services.billing import wallet as wl

        price, cur = wl.email_price(region.code)
        checks.append(wallet_check(db, ctx, price * est.eligible, cur))
    return checks, est


def _require_ready(db: Session, ctx, c: EmailCampaign) -> None:
    checks, _ = readiness(db, ctx, c)
    failing = [ch for ch in checks if not ch.ok and not ch.warning]
    if failing:
        raise ValidationFailed("This campaign is not ready to send", code="CAMPAIGN_NOT_READY",
                               details=[ch.model_dump() for ch in failing])


# ------------------------------------------------------------------ CRUD

def list_campaigns(db: Session, ctx: AppContext, params: PageParams, status: str | None, search: str | None
                   ) -> Page[CampaignListItem]:
    ctx.require(Perm.CAMPAIGNS_READ)
    q = select(EmailCampaign).where(*_visible(ctx))
    if status:
        q = q.where(EmailCampaign.status == status)
    if search:
        q = q.where(func.lower(EmailCampaign.name).like(f"%{search.strip().lower()}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(EmailCampaign.updated_at.desc()).offset(params.offset).limit(params.page_size)))
    stats = stats_for(db, [r.id for r in rows])
    items = []
    for r in rows:
        it = CampaignListItem.model_validate(r)
        it.stats = stats.get(r.id)
        items.append(it)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def create_campaign(db: Session, ctx: AppContext, data: CampaignCreate) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = EmailCampaign(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                      description=data.description, campaign_type=data.campaign_type, created_by_id=ctx.user.id,
                      audience=initial_audience(db, ctx, data.audience))
    # Prefer a verified sender: the default if it is verified, otherwise any verified one, else the default.
    default_sender = db.scalar(select(EmailSender).where(EmailSender.application_id == ctx.application_id)
                               .order_by((EmailSender.status == "verified").desc(), EmailSender.is_default.desc(),
                                         EmailSender.created_at).limit(1))
    if default_sender:
        c.sender_id, c.from_name, c.from_email = default_sender.id, default_sender.from_name, default_sender.from_email
        c.reply_to = default_sender.reply_to
    if data.template_id:
        t = get_template_row(db, ctx, data.template_id)
        c.subject, c.preheader, c.editor, c.design, c.html, c.text = (t.subject, t.preheader, t.editor, t.design,
                                                                      t.html, t.text)
    db.add(c)
    db.flush()
    audit_service.record(db, "email_campaign.created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="email_campaign", target_id=c.id,
                         summary=c.name)
    return c


def get_campaign(db: Session, ctx: AppContext, campaign_id: str) -> CampaignOut:
    ctx.require(Perm.CAMPAIGNS_READ)
    return to_out(db, _get(db, ctx, campaign_id))


def update_campaign(db: Session, ctx: AppContext, campaign_id: str, data: CampaignUpdate) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    if c.status not in EDITABLE:
        raise Conflict("Only draft campaigns can be edited. Unschedule it first.", code="NOT_EDITABLE")
    changes = data.model_dump(exclude_unset=True)
    if "sender_id" in changes:
        if changes["sender_id"]:
            s = db.scalar(select(EmailSender).where(EmailSender.id == changes["sender_id"],
                                                    EmailSender.application_id == ctx.application_id))
            if s is None:
                raise ValidationFailed("Choose a sender from this application", code="INVALID_SENDER")
            c.from_name, c.from_email = s.from_name, s.from_email
            if "reply_to" not in changes:
                c.reply_to = s.reply_to
        else:
            c.from_name = c.from_email = None
    if "audience" in changes and changes["audience"] is not None:
        audience_condition(db, ctx, changes["audience"])  # validate references
    if changes.get("design") is not None:
        import json

        try:
            size = len(json.dumps(changes["design"]))
        except (TypeError, ValueError) as exc:
            raise ValidationFailed("The email design could not be read. Reload the editor and try again.",
                                   code="INVALID_DESIGN") from exc
        if size > MAX_DESIGN_BYTES:
            raise ValidationFailed(f"The email design is too large to save ({size // 1_000_000} MB; the limit is "
                                   f"{MAX_DESIGN_BYTES // 1_000_000} MB). Remove embedded images or large blocks.",
                                   code="DESIGN_TOO_LARGE")
    for k, v in changes.items():
        setattr(c, k, v)
    return c


def delete_campaign(db: Session, ctx: AppContext, campaign_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    if c.status != "draft":
        raise Conflict("Only draft campaigns can be deleted", code="NOT_DELETABLE")
    db.delete(c)
    audit_service.record(db, "email_campaign.deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="email_campaign", target_id=campaign_id,
                         summary=c.name)


def duplicate_campaign(db: Session, ctx: AppContext, campaign_id: str) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    src = _get(db, ctx, campaign_id)
    c = EmailCampaign(organization_id=ctx.organization_id, application_id=ctx.application_id,
                      name=f"{src.name} (copy)"[:160], description=src.description, campaign_type=src.campaign_type,
                      sender_id=src.sender_id, from_name=src.from_name, from_email=src.from_email,
                      reply_to=src.reply_to, subject=src.subject, preheader=src.preheader, editor=src.editor,
                      design=src.design, html=src.html, text=src.text, audience=dict(src.audience or {}),
                      track_opens=src.track_opens, track_clicks=src.track_clicks, created_by_id=ctx.user.id)
    db.add(c)
    db.flush()
    return c


# ------------------------------------------------------------------ preview & test

def _business(db: Session, application_id: str, org_name: str) -> tuple[str | None, str | None]:
    s = _settings(db, application_id)
    return (s.business_name if s and s.business_name else org_name), (s.business_address if s else None)


def preview(db: Session, ctx: AppContext, campaign_id: str, body: PreviewRequest) -> PreviewOut:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    contact = None
    if body.contact_id:
        contact = db.scalar(select(Contact).where(Contact.id == body.contact_id,
                                                  Contact.application_id == ctx.application_id))
        if contact is None:
            raise NotFound("Contact not found")
    subject = body.subject if body.subject is not None else c.subject
    preheader = body.preheader if body.preheader is not None else c.preheader
    html = body.html if body.html is not None else c.html
    text = body.text if body.text is not None else c.text
    issues = render.check([subject, preheader, html, text], custom_keys(db, c.application_id))
    name, addr = _business(db, c.application_id, ctx.organization.name)
    r = render.render(subject=subject, preheader=preheader, html=html, text=text,
                      values=render.contact_values(contact, sample=contact is None), message_id=None, links=None,
                      business_name=name, business_address=addr, track_opens=False, track_clicks=False)
    label = (contact.full_name or contact.email or "Contact") if contact else "Sample contact (Asha Rao)"
    return PreviewOut(subject=r.subject, html=r.html, text=r.text, contact_label=label,
                      issues={"unknown": issues.unknown, "malformed": issues.malformed})


def send_test(db: Session, ctx: AppContext, campaign_id: str, body: TestSendRequest) -> dict:
    from app.services.email.engine import provider_for

    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    sender = db.get(EmailSender, c.sender_id) if c.sender_id else None
    if sender is None or sender.status != "verified" or sender.application_id != ctx.application_id:
        raise ValidationFailed("Choose a verified sender before sending a test", code="SENDER_NOT_VERIFIED")
    if not (c.subject and (c.html or c.text)):
        raise ValidationFailed("Add a subject and content before sending a test", code="INCOMPLETE")
    contact = None
    if body.contact_id:
        contact = db.scalar(select(Contact).where(Contact.id == body.contact_id,
                                                  Contact.application_id == ctx.application_id))
    name, addr = _business(db, c.application_id, ctx.organization.name)
    r = render.render(subject=c.subject, preheader=c.preheader, html=c.html, text=c.text,
                      values=render.contact_values(contact, sample=contact is None), message_id=None, links=None,
                      business_name=name, business_address=addr, track_opens=False, track_clicks=False)
    provider, pname = provider_for(_settings(db, c.application_id))
    results = []
    for to in body.emails:
        res = provider.send(OutboundEmail(to_email=to, subject=f"[Test] {r.subject}", html=r.html, text=r.text,
                                          from_email=sender.from_email, from_name=sender.from_name,
                                          reply_to=c.reply_to, tags=("test",)))
        results.append({"email": to, "accepted": res.accepted, "error": res.error_message})
    audit_service.record(db, "email_campaign.test_sent", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_campaign", target_id=c.id, meta={"count": len(body.emails)})
    return {"provider": pname, "results": results}


# ------------------------------------------------------------------ lifecycle

def schedule(db: Session, ctx: AppContext, campaign_id: str, body: ScheduleRequest) -> EmailCampaign:
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
    audit_service.record(db, "email_campaign.scheduled", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_campaign", target_id=c.id, summary=c.name,
                         meta={"scheduled_at": when.isoformat(), "timezone": body.timezone})
    return c


def unschedule(db: Session, ctx: AppContext, campaign_id: str) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status != "scheduled":
        raise Conflict("This campaign is not scheduled")
    c.status, c.scheduled_at = "draft", None
    audit_service.record(db, "email_campaign.unscheduled", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_campaign", target_id=c.id, summary=c.name)
    return c


def send_now(db: Session, ctx: AppContext, campaign_id: str) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("draft", "scheduled"):
        raise Conflict("This campaign has already been sent or is sending", code="ALREADY_LAUNCHED")
    _require_ready(db, ctx, c)
    c.status, c.scheduled_at = "queued", None
    audit_service.record(db, "email_campaign.launched", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_campaign", target_id=c.id, summary=c.name)
    db.commit()
    from app.tasks.email import launch_email_campaign
    from app.workers.dispatch import dispatch

    dispatch(launch_email_campaign, c.id)
    db.refresh(c)
    return c


def pause(db: Session, ctx: AppContext, campaign_id: str) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("queued", "sending"):
        raise Conflict("Only sending campaigns can be paused")
    c.status = "paused"
    audit_service.record(db, "email_campaign.paused", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="email_campaign", target_id=c.id)
    return c


def resume(db: Session, ctx: AppContext, campaign_id: str) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status != "paused":
        raise Conflict("Only paused campaigns can be resumed")
    c.status = "sending" if c.launched_at else "queued"
    audit_service.record(db, "email_campaign.resumed", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="email_campaign", target_id=c.id)
    db.commit()
    from app.tasks.email import continue_email_campaign, launch_email_campaign
    from app.workers.dispatch import dispatch

    dispatch(continue_email_campaign if c.launched_at else launch_email_campaign, c.id)
    db.refresh(c)
    return c


def cancel(db: Session, ctx: AppContext, campaign_id: str) -> EmailCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ACTIVE:
        raise Conflict("Only queued, sending or paused campaigns can be cancelled")
    c.status, c.completed_at = "cancelled", utcnow()
    db.execute(update(EmailMessage).where(EmailMessage.campaign_id == c.id, EmailMessage.status == "queued")
               .values(status="skipped", error_code="cancelled", error_message="Campaign was cancelled"))
    audit_service.record(db, "email_campaign.cancelled", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="email_campaign", target_id=c.id, summary=c.name)
    return c


# ------------------------------------------------------------------ reporting

def report(db: Session, ctx: AppContext, campaign_id: str) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    st = stats_for(db, [c.id]).get(c.id, CampaignStats())

    def rate(n, d):
        return round(100 * n / d, 2) if d else None

    times = db.execute(select(EmailMessage.first_opened_at, EmailMessage.first_clicked_at)
                       .where(EmailMessage.campaign_id == c.id,
                              or_(EmailMessage.first_opened_at.is_not(None),
                                  EmailMessage.first_clicked_at.is_not(None)))).all()
    start = c.launched_at or c.created_at
    span = max([t for row in times for t in row if t] + [start]) - start
    hourly = span <= timedelta(hours=72)
    buckets: Counter = Counter()
    for opened, clicked in times:
        for kind, t in (("opens", opened), ("clicks", clicked)):
            if t:
                b = t.replace(minute=0, second=0, microsecond=0) if hourly else t.replace(
                    hour=0, minute=0, second=0, microsecond=0)
                buckets[(b, kind)] += 1
    keys = sorted({b for b, _ in buckets})
    timeline = [{"at": k.isoformat(), "opens": buckets[(k, "opens")], "clicks": buckets[(k, "clicks")]} for k in keys]
    links = db.execute(select(EmailEvent.url, func.count(), func.count(func.distinct(EmailEvent.message_id)))
                       .where(EmailEvent.campaign_id == c.id, EmailEvent.type == "clicked")
                       .group_by(EmailEvent.url).order_by(func.count().desc()).limit(10)).all()
    return {
        "campaign": to_out(db, c).model_dump(mode="json", exclude={"design"}),
        "stats": st.model_dump(),
        "rates": {
            # Denominators are explicit so numbers can be audited.
            "delivery_rate": rate(st.delivered, st.sent),
            "bounce_rate": rate(st.bounced, st.sent),
            "open_rate": rate(st.unique_opens, st.delivered),
            "click_rate": rate(st.unique_clicks, st.delivered),
            "click_to_open_rate": rate(st.unique_clicks, st.unique_opens),
            "unsubscribe_rate": rate(st.unsubscribed, st.delivered),
            "complaint_rate": rate(st.complained, st.delivered),
        },
        "timeline": {"granularity": "hour" if hourly else "day", "points": timeline},
        "top_links": [{"url": u, "clicks": n, "unique_clicks": un} for u, n, un in links],
        "simulated": c.provider == "simulation",
    }


def _filter_messages(q, status: str | None):
    m = EmailMessage
    if status == "opened":
        return q.where(m.first_opened_at.is_not(None))
    if status == "clicked":
        return q.where(m.first_clicked_at.is_not(None))
    if status == "unsubscribed":
        return q.where(m.unsubscribed_at.is_not(None))
    if status == "bounced":
        return q.where(m.bounced_at.is_not(None))
    if status == "complained":
        return q.where(m.complained_at.is_not(None))
    if status == "not_opened":  # delivered (or at least accepted) but never opened
        return q.where(m.accepted_at.is_not(None), m.bounced_at.is_(None), m.first_opened_at.is_(None))
    if status == "not_clicked":
        return q.where(m.accepted_at.is_not(None), m.bounced_at.is_(None), m.first_clicked_at.is_(None))
    if status:
        return q.where(m.status == status)
    return q


def recipient_ids(db: Session, ctx: AppContext, campaign_id: str, status: str | None) -> dict:
    """Contact ids behind a report filter, for bulk actions (tag, list, task, workflow, resend)."""
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    q = _filter_messages(select(EmailMessage.contact_id).where(EmailMessage.campaign_id == c.id,
                                                               EmailMessage.contact_id.is_not(None)), status)
    return capped_ids(db, q)


def capped_ids(db: Session, q) -> dict:
    total = db.scalar(select(func.count()).select_from(q.distinct().subquery())) or 0
    ids = list(db.scalars(q.distinct().limit(MAX_RECIPIENT_IDS)))
    return {"contact_ids": ids, "total": total, "truncated": total > len(ids), "limit": MAX_RECIPIENT_IDS}


def list_messages(db: Session, ctx: AppContext, campaign_id: str, params: PageParams, status: str | None,
                  search: str | None) -> Page[MessageOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    q = _filter_messages(select(EmailMessage).where(EmailMessage.campaign_id == c.id), status)
    if search:
        q = q.where(EmailMessage.to_email.like(f"%{search.strip().lower()}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(EmailMessage.created_at, EmailMessage.id).offset(params.offset)
                      .limit(params.page_size))
    return Page(items=[MessageOut.model_validate(r) for r in rows], total=total, page=params.page,
                page_size=params.page_size)


def overview(db: Session, ctx: AppContext) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    since = utcnow() - timedelta(days=30)
    by_status = dict(db.execute(select(EmailCampaign.status, func.count()).where(
        *_visible(ctx)).group_by(EmailCampaign.status)).all())
    ids = list(db.scalars(select(EmailCampaign.id).where(*_visible(ctx),
                                                         EmailCampaign.launched_at >= since)))
    agg = CampaignStats()
    for s in stats_for(db, ids).values():
        for k in agg.model_fields:
            setattr(agg, k, getattr(agg, k) + getattr(s, k))
    recent = list(db.scalars(select(EmailCampaign).where(*_visible(ctx))
                             .order_by(EmailCampaign.updated_at.desc()).limit(5)))
    rs = stats_for(db, [r.id for r in recent])
    upcoming = list(db.scalars(select(EmailCampaign).where(*_visible(ctx),
                                                           EmailCampaign.status == "scheduled")
                               .order_by(EmailCampaign.scheduled_at).limit(5)))
    senders = db.execute(select(EmailSender.status, func.count()).where(
        EmailSender.application_id == ctx.application_id).group_by(EmailSender.status)).all()

    def pct(n, d):
        return round(100 * n / d, 1) if d else None

    return {
        "campaigns_by_status": by_status,
        "last_30_days": {**agg.model_dump(), "campaigns": len(ids),
                         "delivery_rate": pct(agg.delivered, agg.sent), "open_rate": pct(agg.unique_opens, agg.delivered),
                         "click_rate": pct(agg.unique_clicks, agg.delivered)},
        "recent": [{**CampaignListItem.model_validate(r).model_dump(mode="json"),
                    "stats": (rs.get(r.id) or CampaignStats()).model_dump()} for r in recent],
        "upcoming": [CampaignListItem.model_validate(r).model_dump(mode="json") for r in upcoming],
        "senders": dict(senders),
    }


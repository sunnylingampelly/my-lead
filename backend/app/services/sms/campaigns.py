"""SMS campaign lifecycle: draft → scheduled/queued → sending ⇄ paused → completed | cancelled | failed."""
from collections import Counter
from datetime import timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import case, exists, func, not_, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import Contact, SuppressionEntry
from app.models.sms import SmsCampaign, SmsInbound, SmsMessage, SmsSender, SmsTemplate
from app.providers.sms.base import OutboundSms
from app.providers.sms.factory import live_credentials_missing, provider_for
from app.schemas.common import Page, PageParams
from app.schemas.email import Estimate, ReadinessCheck, ScheduleRequest
from app.schemas.sms import CampaignCreate, CampaignListItem, CampaignOut, CampaignUpdate, MessageOut, Stats, TestSend
from app.services import audit_service, uae
from app.services.audience.query import base_query, count, eligibility_condition
from app.services.email import readiness as rd
from app.services.email import render
from app.services.email.campaigns import audience_condition, capped_ids, custom_keys, initial_audience
from app.services.sms import rules
from app.services.sms.encoding import analyse
from app.services.sms.registration import dlt_row, template_row
from app.services.tenancy import AppContext
from app.utils.contact_normalize import parse_phone
from app.utils.time import utcnow

EDITABLE = ("draft",)
ACTIVE = ("queued", "sending", "paused")
COUNTRY_NAME = {"IN": "India", "AE": "the UAE", "US": "the United States"}
# What applies to UAE SMS once it is switched on (shown with the "coming soon" state).
UAE_SMS_RULES = (
    "Promotional sender IDs start with \"AD-\" (11 characters at most, including the prefix)",
    "Promotional texts are not delivered from 21:00 to 07:00 UAE time; they wait until 07:00",
    "Opt-out text is added to every promotional text (in Arabic for Arabic messages)",
    "Only UAE-licensed businesses that upload their consents to TDRA's Consent Management System may send "
    "promotional texts",
    "Links, phone numbers and WhatsApp links must be allow-listed with the carrier",
)



def _visible(ctx) -> tuple:
    """Campaigns shown in lists and overviews: this application's, without hidden automation steps."""
    return (SmsCampaign.application_id == ctx.application_id, SmsCampaign.status != "automation")

def _get(db: Session, ctx, campaign_id: str, lock: bool = False) -> SmsCampaign:
    q = select(SmsCampaign).where(SmsCampaign.id == campaign_id, SmsCampaign.application_id == ctx.application_id)
    if lock:
        q = q.with_for_update()
    c = db.scalar(q)
    if c is None:
        raise NotFound("Campaign not found")
    return c


def sender_of(db: Session, c: SmsCampaign) -> SmsSender | None:
    s = db.get(SmsSender, c.sender_ref) if c.sender_ref else None
    return s if s is not None and s.application_id == c.application_id else None


def stats_for(db: Session, campaign_ids: list[str]) -> dict[str, Stats]:
    if not campaign_ids:
        return {}
    m = SmsMessage
    s = lambda cond: func.sum(case((cond, 1), else_=0))  # noqa: E731
    billed = m.accepted_at.is_not(None)
    rows = db.execute(select(
        m.campaign_id, func.count(), s(m.status.in_(("queued", "sending"))), s(m.status == "deferred"), s(billed),
        s(m.status == "delivered"), s(m.status == "undelivered"), s(m.status == "failed"), s(m.status == "skipped"),
        func.coalesce(func.sum(case((billed, m.segments), else_=0)), 0),
        func.coalesce(func.sum(case((billed, m.cost), else_=0)), 0),
    ).where(m.campaign_id.in_(campaign_ids)).group_by(m.campaign_id)).all()
    return {r[0]: Stats(recipients=r[1], queued=r[2] or 0, deferred=r[3] or 0, sent=r[4] or 0, delivered=r[5] or 0,
                        undelivered=r[6] or 0, failed=r[7] or 0, skipped=r[8] or 0, segments=int(r[9] or 0),
                        cost=round(float(r[10] or 0), 4)) for r in rows}


def to_out(db: Session, c: SmsCampaign) -> CampaignOut:
    out = CampaignOut.model_validate(c)
    out.stats = stats_for(db, [c.id]).get(c.id, Stats())
    return out


# ------------------------------------------------------------------ audience & cost


def estimate(db: Session, ctx, audience: dict, country: str | None) -> Estimate:
    base = base_query(ctx).where(audience_condition(db, ctx, audience))
    matched = count(db, base)
    eligible_q = base.where(eligibility_condition("sms"))
    if country:
        eligible_q = eligible_q.where(Contact.phone_country == country)
    suppressed = exists().where(SuppressionEntry.application_id == Contact.application_id,
                                SuppressionEntry.channel == "sms", SuppressionEntry.value_hash == Contact.phone_hash)
    steps = [
        ("no_phone", Contact.phone.is_(None)),
        ("landline", Contact.phone_type == "landline"),
        ("unsubscribed", Contact.sms_unsubscribed_at.is_not(None)),
        ("blocked", Contact.status == "blocked"),
        ("suppressed", suppressed),
        ("no_consent", Contact.sms_consent.is_not(True)),
    ]
    if country:
        steps.append(("other_country", func.coalesce(Contact.phone_country, "") != country))
    excluded, prior = {}, []
    for key, cond in steps:
        excluded[key] = count(db, base.where(cond, *[not_(p) for p in prior]))
        prior.append(cond)
    return Estimate(matched=matched, eligible=count(db, eligible_q), excluded=excluded)


def message_shape(body: str | None, *, country: str | None, category: str, append_opt_out: bool) -> dict:
    """Segments and encoding for the body as a sample contact would receive it."""
    sample = render.substitute(body or "", render.contact_values(None, sample=True), escape=False)
    text = rules.final_body(sample, country=country or "", category=category, append_opt_out=append_opt_out)
    info = analyse(text)
    return {"text": text, "encoding": info.encoding, "characters": info.characters, "segments": info.segments,
            "per_segment": info.per_segment, "remaining": info.remaining, "non_gsm": info.non_gsm}


def cost_estimate(recipients: int, segments: int, country: str | None, category: str) -> dict:
    unit, currency = rules.price(country, category)
    return {"unit_price": unit, "currency": currency, "total": round(recipients * max(segments, 1) * unit, 2)}


# ------------------------------------------------------------------ readiness


def _check(key: str, label: str, ok: bool, detail: str | None = None, **kw) -> ReadinessCheck:
    return rd.check(key, label, ok, detail, **kw)


def country_of(db: Session, ctx, c: SmsCampaign) -> tuple[SmsSender | None, str | None]:
    """The chosen sender and the country it texts; before a sender is chosen, the app's home market."""
    sender = sender_of(db, c)
    return sender, rd.effective_country(ctx, sender.country if sender else None)


def eligible_query(db: Session, ctx, audience: dict, country: str | None):
    q = base_query(ctx).where(audience_condition(db, ctx, audience), eligibility_condition("sms"))
    return q.where(Contact.phone_country == country) if country else q


def quiet_wait(db: Session, ctx, c: SmsCampaign, country: str | None) -> dict:
    """Promotional texts are held during quiet hours: the window, and who would wait if sent now."""
    quiet = rd.quiet_hours(db, c.application_id)
    window = rd.effective_window(None, quiet)
    out = {"applies": c.category == "promotional", "window": window, "waiting": 0, "next_window_at": None,
           "timezone": None}
    if c.category != "promotional":
        return out
    try:
        q = eligible_query(db, ctx, c.audience or {}, country)
    except ValidationFailed:
        return out
    app_tz = ctx.application.timezone if ctx.application else None
    w = rd.waiting_estimate(db, q, app_tz, lambda now, tz: rules.quiet_until(now, tz, *quiet))
    return {**out, **(w or {})}


def uae_attested(reg) -> bool:
    return bool(reg and reg.uae_attested_at)


def uae_checks(db: Session, ctx, c: SmsCampaign, sender: SmsSender | None, pending: bool) -> list[ReadinessCheck]:
    """UAE (TDRA) rules. The kill switch comes first: while SMS_UAE_ENABLED is off nothing can be sent."""
    out: list[ReadinessCheck] = []
    blocked = uae.sms_blocked("AE")
    out.append(_check("uae_available", "SMS to the UAE", blocked is None, blocked, step="setup"))
    reg_url = rd.app_url(ctx, "/sms/registration")
    if c.category == "promotional":
        out.append(_check("uae_attestation", "UAE licence and TDRA consent upload", uae_attested(dlt_row(db, c.application_id)),
                          "Promotional SMS in the UAE may only come from UAE-licensed businesses whose recipients' "
                          "consents are uploaded to TDRA's Consent Management System. Confirm both.",
                          action_url=reg_url, action_label="UAE confirmation"))
        if sender is None:
            out.append(_check("category", "\"AD-\" sender ID for promotional texts", False,
                              "UAE promotional texts need a sender ID starting with \"AD-\"", step="setup",
                              action_url=rd.app_url(ctx, "/sms/senders"), action_label="Add sender ID",
                              pending=True))
        else:
            out.append(_check("category", "\"AD-\" sender ID for promotional texts",
                              sender.sender_id.startswith(uae.PROMO_PREFIX),
                              "UAE promotional texts need a sender ID starting with \"AD-\"", step="setup"))
        out.append(_check("opt_out", "Opt-out text", True))  # appended automatically (rules.final_body)
    elif sender is not None:
        out.append(_check("category", "Sender ID matches message category",
                          not sender.sender_id.startswith(uae.PROMO_PREFIX),
                          "\"AD-\" sender IDs are for promotional texts only", step="setup"))
    if uae.has_url(c.body):
        w = _check("uae_links", "Links in the message", False,
                   "UAE carriers block links, phone numbers and WhatsApp links unless they were allow-listed with "
                   "your sender ID. Remove the link or make sure it is allow-listed.", step="message")
        w.warning = True
        out.append(w)
    return out


def readiness(db: Session, ctx, c: SmsCampaign) -> tuple[list[ReadinessCheck], Estimate | None]:
    checks: list[ReadinessCheck] = []
    if not settings.SMS_ENABLED:
        checks.append(_check("sms_available", "SMS", False, uae.SMS_GLOBAL_COMING_SOON, step="setup"))
    sender, country = country_of(db, ctx, c)
    senders_url, reg_url = rd.app_url(ctx, "/sms/senders"), rd.app_url(ctx, "/sms/registration")
    templates_url = rd.app_url(ctx, "/sms/templates")
    pending = sender is None  # the app's market requirements, shown before a sender is chosen
    if sender is None:
        checks.append(_check("sender", "Approved sender ID", False,
                             "Choose a sender ID" + (f" for {COUNTRY_NAME[country]}" if country else ""),
                             step="setup", action_url=senders_url, action_label="Add sender ID"))
    else:
        checks.append(_check("sender", "Approved sender ID", sender.status == "active",
                             f"Confirm that {sender.sender_id} is registered with your operator before sending",
                             step="setup", action_url=senders_url, action_label="Confirm sender ID",
                             meta={"sender_id": sender.id, "status": sender.status}))
    reg = dlt_row(db, c.application_id)

    if country == "IN":
        pe_ok = bool(reg and reg.principal_entity_id and reg.attested_at)
        checks.append(_check("registration", "DLT entity registration", pe_ok,
                             "Indian operators only deliver texts from businesses registered on a DLT portal. "
                             "Add and confirm your Principal Entity (PE) ID.",
                             action_url=reg_url, action_label="DLT registration"))
        want = "numeric (promotional)" if c.category == "promotional" else "alphabetic (service/transactional)"
        if sender is None:
            checks.append(_check("category", "Header matches message category", False,
                                 f"This {c.category} text needs a {want} DLT header", step="setup",
                                 action_url=senders_url, action_label="Add sender ID", pending=True))
        else:
            kind_ok = (sender.kind == "promotional") == (c.category == "promotional")
            checks.append(_check("category", "Header matches message category", kind_ok,
                                 "Promotional messages use a numeric header; service and transactional messages "
                                 "use an alphabetic header", step="setup"))
        t = db.get(SmsTemplate, c.template_id) if c.template_id else None
        if t is None or t.application_id != c.application_id or not t.dlt_template_id:
            checks.append(_check("dlt_template", "Approved DLT content template", False,
                                 "Indian SMS must use a content template registered on DLT. Pick (or add) a "
                                 "template with its DLT template ID.", step="setup", action_url=templates_url,
                                 action_label="SMS templates", pending=pending))
        else:
            ok = bool(t.dlt_template_text) and rules.matches_dlt(c.body or "", t.dlt_template_text)
            checks.append(_check("dlt_template", "Approved DLT content template", ok,
                                 "The message must match the registered DLT text exactly, with fields only where "
                                 "{#var#} appears", step="message"))
    elif country == "US":
        if sender is None or sender.kind == "long_code":
            ok = bool(reg and reg.us_brand_id and reg.us_campaign_id and reg.attested_at)
            checks.append(_check("registration", "A2P 10DLC registration", ok,
                                 "US carriers block unregistered 10DLC traffic. Add and confirm your brand and "
                                 "campaign IDs.", action_url=reg_url, action_label="10DLC registration",
                                 pending=pending))
        if c.category == "promotional":
            text = rules.final_body(c.body or "", country="US", category=c.category, append_opt_out=c.append_opt_out)
            ok = "stop" in text.lower()
            checks.append(_check("opt_out", "Opt-out instructions (STOP)", ok,
                                 "US marketing texts must tell people how to opt out. Turn on “Reply STOP to "
                                 "opt out” or add it to the message.", step="message"))
    elif country == "AE":
        checks.extend(uae_checks(db, ctx, c, sender, pending))
    if country != "AE":
        # Kill switch also covers a UAE application texting another market.
        blocked = uae.sms_blocked(getattr(ctx.application, "default_country", None))
        if blocked:
            checks.append(_check("uae_available", "SMS to the UAE", False, blocked, step="setup"))

    body_ok = bool((c.body or "").strip())
    checks.append(_check("content", "Message text", body_ok, "Write the message", step="message"))
    if body_ok:
        issues = render.check([c.body], custom_keys(db, c.application_id))
        bad = issues.unknown + [v for v in render.variables_in(c.body) if v in render.SYSTEM_VARIABLES]
        detail = ("Unknown fields: " + ", ".join(bad)) if bad else (
            "Unsupported template syntax: " + ", ".join(issues.malformed[:3]))
        checks.append(_check("personalisation", "Personalisation fields", not bad and not issues.malformed, detail,
                             step="message"))

    if settings.COMMUNICATION_MODE == "live" and sender:
        missing = live_credentials_missing(sender.provider)
        checks.append(_check("provider", "SMS provider connected", missing is None, missing,
                             action_url=rd.app_url(ctx, "/settings?tab=delivery"), action_label="Settings"))

    if country:
        consented = count(db, base_query(ctx).where(eligibility_condition("sms"), Contact.phone_country == country))
        checks.append(_check(
            "consent", "Contacts with SMS consent" + (" (TCPA)" if country == "US" else ""), consented > 0,
            f"No contact with a mobile number in {COUNTRY_NAME[country]} has given SMS consent yet. Import "
            "contacts with their consent, or record consent on each contact.",
            action_url=rd.app_url(ctx, "/audience/import"), action_label="Import contacts"))

    est = None
    try:
        est = estimate(db, ctx, c.audience or {}, country)
        ok = est.eligible > 0
        detail = "Choose who should receive this text" if not est.matched else (
            f"No one in this audience has an SMS-consented mobile number in {COUNTRY_NAME.get(country, country)}"
            if country else "No one in this audience can receive marketing SMS")
        checks.append(_check("audience", "Audience with reachable contacts", ok, detail, step="audience"))
    except ValidationFailed as exc:
        checks.append(_check("audience", "Audience with reachable contacts", False, exc.message, step="audience"))
    if est and est.eligible > 0:
        shape = message_shape(c.body, country=country, category=c.category, append_opt_out=c.append_opt_out)
        cost = cost_estimate(est.eligible, shape["segments"], country, c.category)
        checks.append(rd.wallet_check(db, ctx, cost["total"], cost["currency"]))
    return checks, est


def _require_ready(db: Session, ctx, c: SmsCampaign) -> None:
    checks, _ = readiness(db, ctx, c)
    failing = [ch for ch in checks if not ch.ok and not ch.warning]
    if failing:
        raise ValidationFailed("This campaign is not ready to send", code="CAMPAIGN_NOT_READY",
                               details=[ch.model_dump() for ch in failing])


# ------------------------------------------------------------------ CRUD


def list_campaigns(db: Session, ctx: AppContext, params: PageParams, status: str | None, search: str | None
                   ) -> Page[CampaignListItem]:
    ctx.require(Perm.CAMPAIGNS_READ)
    q = select(SmsCampaign).where(*_visible(ctx))
    if status:
        q = q.where(SmsCampaign.status == status)
    if search:
        q = q.where(func.lower(SmsCampaign.name).like(f"%{search.strip().lower()}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(SmsCampaign.updated_at.desc()).offset(params.offset).limit(params.page_size)))
    stats = stats_for(db, [r.id for r in rows])
    items = []
    for r in rows:
        it = CampaignListItem.model_validate(r)
        it.stats = stats.get(r.id)
        items.append(it)
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def _apply_template(db: Session, ctx, c: SmsCampaign, template_id: str) -> None:
    t = template_row(db, ctx, template_id)
    c.template_id, c.body, c.category = t.id, t.body, t.category
    if t.sender_ref:
        c.sender_ref = t.sender_ref


def create_campaign(db: Session, ctx: AppContext, data: CampaignCreate) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = SmsCampaign(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                    description=data.description, category=data.category, created_by_id=ctx.user.id,
                    audience=initial_audience(db, ctx, data.audience), append_opt_out=True,
                    sender_snapshot={}, excluded={})
    # Prefer an approved sender: the default if active, otherwise any active one, else the default.
    default = db.scalar(select(SmsSender).where(SmsSender.application_id == ctx.application_id)
                        .order_by((SmsSender.status == "active").desc(), SmsSender.is_default.desc(),
                                  SmsSender.created_at).limit(1))
    if default:
        c.sender_ref = default.id
    if data.template_id:
        _apply_template(db, ctx, c, data.template_id)
    db.add(c)
    db.flush()
    audit_service.record(db, "sms_campaign.created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_campaign", target_id=c.id,
                         summary=c.name)
    return c


def get_campaign(db: Session, ctx: AppContext, campaign_id: str) -> CampaignOut:
    ctx.require(Perm.CAMPAIGNS_READ)
    return to_out(db, _get(db, ctx, campaign_id))


def update_campaign(db: Session, ctx: AppContext, campaign_id: str, data: CampaignUpdate) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    if c.status not in EDITABLE:
        raise Conflict("Only draft campaigns can be edited. Unschedule it first.", code="NOT_EDITABLE")
    changes = data.model_dump(exclude_unset=True)
    if changes.get("sender_ref"):
        s = db.scalar(select(SmsSender).where(SmsSender.id == changes["sender_ref"],
                                              SmsSender.application_id == ctx.application_id))
        if s is None:
            raise ValidationFailed("Choose a sender ID from this application", code="INVALID_SENDER")
    if "template_id" in changes:
        tid = changes.pop("template_id")
        if tid and tid != c.template_id:
            _apply_template(db, ctx, c, tid)
        elif not tid:
            c.template_id = None
    if changes.get("audience") is not None:
        audience_condition(db, ctx, changes["audience"])  # validate references
    for k, v in changes.items():
        if k in ("name", "category", "append_opt_out") and v is None:
            continue
        setattr(c, k, v)
    return c


def delete_campaign(db: Session, ctx: AppContext, campaign_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    if c.status != "draft":
        raise Conflict("Only draft campaigns can be deleted", code="NOT_DELETABLE")
    db.delete(c)
    audit_service.record(db, "sms_campaign.deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_campaign", target_id=campaign_id,
                         summary=c.name)


def duplicate_campaign(db: Session, ctx: AppContext, campaign_id: str) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    src = _get(db, ctx, campaign_id)
    c = SmsCampaign(organization_id=ctx.organization_id, application_id=ctx.application_id,
                    name=f"{src.name} (copy)"[:160], description=src.description, category=src.category,
                    sender_ref=src.sender_ref, template_id=src.template_id, body=src.body,
                    append_opt_out=src.append_opt_out, audience=dict(src.audience or {}), created_by_id=ctx.user.id,
                    sender_snapshot={}, excluded={})
    db.add(c)
    db.flush()
    return c


# ------------------------------------------------------------------ preview & test


def personalise(body: str, contact: Contact | None, *, country: str | None, sample: bool = False) -> str:
    values = render.contact_values(contact, sample=sample)
    if country == "IN":
        # Indian operators reject variable values longer than 30 characters.
        values = {k: v[: rules.DLT_VAR_MAX].rstrip() for k, v in values.items()}
    return render.substitute(body, values, escape=False)


def preview(db: Session, ctx: AppContext, campaign_id: str, contact_id: str | None, body: str | None) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    contact = None
    if contact_id:
        contact = db.scalar(select(Contact).where(Contact.id == contact_id, Contact.application_id == ctx.application_id))
        if contact is None:
            raise NotFound("Contact not found")
    sender = sender_of(db, c)
    country = sender.country if sender else None
    text = personalise(body if body is not None else (c.body or ""), contact, country=country, sample=contact is None)
    text = rules.final_body(text, country=country or "", category=c.category, append_opt_out=c.append_opt_out)
    info = analyse(text)
    label = (contact.full_name or contact.phone or "Contact") if contact else "Sample contact (Asha Rao)"
    return {"text": text, "contact_label": label, "sender": sender.sender_id if sender else None,
            "encoding": info.encoding, "characters": info.characters, "segments": info.segments,
            "per_segment": info.per_segment, "remaining": info.remaining, "non_gsm": info.non_gsm,
            "dlt_pattern": rules.to_dlt_pattern(body if body is not None else (c.body or ""))}


def send_test(db: Session, ctx: AppContext, campaign_id: str, data: TestSend) -> dict:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    c = _get(db, ctx, campaign_id)
    sender = sender_of(db, c)
    if sender is None or sender.status != "active":
        raise ValidationFailed("Choose a confirmed sender ID before sending a test", code="SENDER_NOT_ACTIVE")
    if not (c.body or "").strip():
        raise ValidationFailed("Write the message before sending a test", code="INCOMPLETE")
    contact = None
    if data.contact_id:
        contact = db.scalar(select(Contact).where(Contact.id == data.contact_id,
                                                  Contact.application_id == ctx.application_id))
    text = rules.final_body(personalise(c.body, contact, country=sender.country, sample=contact is None),
                            country=sender.country, category=c.category, append_opt_out=c.append_opt_out)
    info = analyse(text)
    t = db.get(SmsTemplate, c.template_id) if c.template_id else None
    reg = dlt_row(db, c.application_id)
    provider, pname = provider_for(sender.provider)
    results = []
    for raw in data.phones:
        parsed = parse_phone(raw, sender.country)
        if parsed is None:
            results.append({"phone": raw, "accepted": False, "error": "Not a valid phone number"})
            continue
        blocked = uae.sms_blocked(parsed.country, parsed.e164)
        if blocked:
            results.append({"phone": parsed.e164, "accepted": False, "error": blocked})
            continue
        if parsed.country != sender.country:
            results.append({"phone": parsed.e164, "accepted": False,
                            "error": f"{sender.sender_id} can only text numbers in {COUNTRY_NAME[sender.country]}"})
            continue
        res = provider.send(OutboundSms(
            to=parsed.e164, sender_id=sender.sender_id, body=text, category=c.category,
            unicode=info.encoding == "UCS-2", dlt_template_id=t.dlt_template_id if t else None,
            dlt_entity_id=reg.principal_entity_id if reg else None,
            country=sender.country))
        results.append({"phone": parsed.e164, "accepted": res.accepted, "error": res.error_message})
    audit_service.record(db, "sms_campaign.test_sent", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_campaign", target_id=c.id,
                         meta={"count": len(data.phones)})
    return {"provider": pname, "segments": info.segments, "results": results}


# ------------------------------------------------------------------ lifecycle


def _audit(db: Session, ctx, action: str, c: SmsCampaign, meta: dict | None = None) -> None:
    audit_service.record(db, f"sms_campaign.{action}", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_campaign", target_id=c.id,
                         summary=c.name, meta=meta)


def schedule(db: Session, ctx: AppContext, campaign_id: str, body: ScheduleRequest) -> SmsCampaign:
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


def unschedule(db: Session, ctx: AppContext, campaign_id: str) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status != "scheduled":
        raise Conflict("This campaign is not scheduled")
    c.status, c.scheduled_at = "draft", None
    _audit(db, ctx, "unscheduled", c)
    return c


def _dispatch(task_name: str, campaign_id: str) -> None:
    from app.tasks import sms as sms_tasks
    from app.workers.dispatch import dispatch

    dispatch(getattr(sms_tasks, task_name), campaign_id)


def send_now(db: Session, ctx: AppContext, campaign_id: str) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("draft", "scheduled"):
        raise Conflict("This campaign has already been sent or is sending", code="ALREADY_LAUNCHED")
    _require_ready(db, ctx, c)
    c.status, c.scheduled_at = "queued", None
    _audit(db, ctx, "launched", c)
    db.commit()
    _dispatch("launch_sms_campaign", c.id)
    db.refresh(c)
    return c


def pause(db: Session, ctx: AppContext, campaign_id: str) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ("queued", "sending"):
        raise Conflict("Only sending campaigns can be paused")
    c.status = "paused"
    _audit(db, ctx, "paused", c)
    return c


def resume(db: Session, ctx: AppContext, campaign_id: str) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status != "paused":
        raise Conflict("Only paused campaigns can be resumed")
    c.status = "sending" if c.launched_at else "queued"
    _audit(db, ctx, "resumed", c)
    db.commit()
    _dispatch("continue_sms_campaign" if c.launched_at else "launch_sms_campaign", c.id)
    db.refresh(c)
    return c


def cancel(db: Session, ctx: AppContext, campaign_id: str) -> SmsCampaign:
    ctx.require(Perm.CAMPAIGNS_LAUNCH)
    c = _get(db, ctx, campaign_id, lock=True)
    if c.status not in ACTIVE:
        raise Conflict("Only queued, sending or paused campaigns can be cancelled")
    c.status, c.completed_at = "cancelled", utcnow()
    db.execute(update(SmsMessage).where(SmsMessage.campaign_id == c.id, SmsMessage.status.in_(("queued", "deferred")))
               .values(status="skipped", error_code="cancelled", error_message="Campaign was cancelled",
                       updated_at=utcnow()))
    _audit(db, ctx, "cancelled", c)
    return c


# ------------------------------------------------------------------ reporting


def report(db: Session, ctx: AppContext, campaign_id: str) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    st = stats_for(db, [c.id]).get(c.id, Stats())

    def rate(n, d):
        return round(100 * n / d, 2) if d else None

    times = db.execute(select(SmsMessage.accepted_at, SmsMessage.delivered_at).where(
        SmsMessage.campaign_id == c.id, SmsMessage.accepted_at.is_not(None))).all()
    start = c.launched_at or c.created_at
    span = max([t for row in times for t in row if t] + [start]) - start
    hourly = span <= timedelta(hours=72)
    buckets: Counter = Counter()
    for sent_at, delivered_at in times:
        for kind, t in (("sent", sent_at), ("delivered", delivered_at)):
            if t:
                b = t.replace(minute=0, second=0, microsecond=0) if hourly else t.replace(
                    hour=0, minute=0, second=0, microsecond=0)
                buckets[(b, kind)] += 1
    keys = sorted({b for b, _ in buckets})
    reasons = db.execute(select(SmsMessage.status, SmsMessage.error_code, SmsMessage.error_message, func.count())
                         .where(SmsMessage.campaign_id == c.id,
                                SmsMessage.status.in_(("failed", "undelivered", "skipped")))
                         .group_by(SmsMessage.status, SmsMessage.error_code, SmsMessage.error_message)
                         .order_by(func.count().desc()).limit(10)).all()
    deferred = db.execute(select(SmsMessage.deferred_reason, func.min(SmsMessage.next_attempt_at), func.count())
                          .where(SmsMessage.campaign_id == c.id, SmsMessage.status == "deferred")
                          .group_by(SmsMessage.deferred_reason)).all()
    return {
        "campaign": to_out(db, c).model_dump(mode="json"),
        "stats": st.model_dump(),
        "rates": {"delivery_rate": rate(st.delivered, st.sent), "failure_rate": rate(st.failed + st.undelivered,
                                                                                     st.sent + st.failed),
                  "segments_per_message": round(st.segments / st.sent, 2) if st.sent else None},
        "timeline": {"granularity": "hour" if hourly else "day",
                     "points": [{"at": k.isoformat(), "sent": buckets[(k, "sent")],
                                 "delivered": buckets[(k, "delivered")]} for k in keys]},
        "failure_reasons": [{"status": s, "code": code, "message": msg, "count": n} for s, code, msg, n in reasons],
        "deferred": [{"reason": r, "next_attempt_at": at.isoformat() if at else None, "count": n}
                     for r, at, n in deferred],
        "simulated": c.provider == "simulation",
    }


def _filter_messages(q, status: str | None, campaign_id: str):
    if status == "replied":
        return q.where(SmsMessage.contact_id.in_(select(SmsInbound.contact_id).where(
            SmsInbound.campaign_id == campaign_id, SmsInbound.contact_id.is_not(None))))
    if status == "opted_out":
        return q.where(SmsMessage.contact_id.in_(select(SmsInbound.contact_id).where(
            SmsInbound.campaign_id == campaign_id, SmsInbound.keyword == "stop", SmsInbound.contact_id.is_not(None))))
    if status == "not_delivered":
        return q.where(SmsMessage.status.in_(("failed", "undelivered")))
    if status:
        return q.where(SmsMessage.status == status)
    return q


def recipient_ids(db: Session, ctx: AppContext, campaign_id: str, status: str | None) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    return capped_ids(db, _filter_messages(select(SmsMessage.contact_id).where(
        SmsMessage.campaign_id == c.id, SmsMessage.contact_id.is_not(None)), status, c.id))


def list_messages(db: Session, ctx: AppContext, campaign_id: str, params: PageParams, status: str | None,
                  search: str | None) -> Page[MessageOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    c = _get(db, ctx, campaign_id)
    q = _filter_messages(select(SmsMessage).where(SmsMessage.campaign_id == c.id), status, c.id)
    if search:
        digits = "".join(ch for ch in search if ch.isdigit())
        if digits:
            q = q.where(SmsMessage.to_phone.like(f"%{digits}%"))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = db.scalars(q.order_by(SmsMessage.created_at, SmsMessage.id).offset(params.offset).limit(params.page_size))
    return Page(items=[MessageOut.model_validate(r) for r in rows], total=total, page=params.page,
                page_size=params.page_size)


def overview(db: Session, ctx: AppContext) -> dict:
    ctx.require(Perm.CAMPAIGNS_READ)
    since = utcnow() - timedelta(days=30)
    by_status = dict(db.execute(select(SmsCampaign.status, func.count()).where(
        *_visible(ctx)).group_by(SmsCampaign.status)).all())
    launched = list(db.scalars(select(SmsCampaign).where(*_visible(ctx),
                                                         SmsCampaign.launched_at >= since)))
    agg = Stats()
    stats = stats_for(db, [c.id for c in launched])
    for s in stats.values():
        for k in Stats.model_fields:
            setattr(agg, k, getattr(agg, k) + getattr(s, k))
    spend: dict[str, float] = {}
    for c in launched:
        s = stats.get(c.id)
        if s and c.currency:
            spend[c.currency] = round(spend.get(c.currency, 0) + s.cost, 2)
    recent = list(db.scalars(select(SmsCampaign).where(*_visible(ctx))
                             .order_by(SmsCampaign.updated_at.desc()).limit(5)))
    rs = stats_for(db, [r.id for r in recent])
    upcoming = list(db.scalars(select(SmsCampaign).where(*_visible(ctx),
                                                         SmsCampaign.status == "scheduled")
                               .order_by(SmsCampaign.scheduled_at).limit(5)))
    senders = db.execute(select(SmsSender.status, func.count()).where(
        SmsSender.application_id == ctx.application_id).group_by(SmsSender.status)).all()
    reg = dlt_row(db, ctx.application_id)
    opt_outs = db.scalar(select(func.count()).select_from(SmsInbound).where(
        SmsInbound.application_id == ctx.application_id, SmsInbound.keyword == "stop",
        SmsInbound.received_at >= since)) or 0
    return {
        "campaigns_by_status": by_status,
        "last_30_days": {**agg.model_dump(), "campaigns": len(launched), "spend": spend, "opt_outs": opt_outs,
                         "delivery_rate": round(100 * agg.delivered / agg.sent, 1) if agg.sent else None},
        "recent": [{**CampaignListItem.model_validate(r).model_dump(mode="json"),
                    "stats": (rs.get(r.id) or Stats()).model_dump()} for r in recent],
        "upcoming": [CampaignListItem.model_validate(r).model_dump(mode="json") for r in upcoming],
        "senders": dict(senders),
        "registration": {"india": bool(reg and reg.principal_entity_id and reg.attested_at),
                         "us": bool(reg and reg.us_brand_id and reg.us_campaign_id and reg.attested_at),
                         "uae": uae_attested(reg)},
        "setup": setup_facts(db, ctx),
    }


def setup_facts(db: Session, ctx) -> dict:
    """What the overview's setup checklist needs, per market."""
    consented = dict(db.execute(
        base_query(ctx).where(eligibility_condition("sms"), Contact.phone_country.in_(("IN", "AE", "US")))
        .with_only_columns(Contact.phone_country, func.count()).group_by(Contact.phone_country).order_by(None)).all())
    dlt_templates = db.scalar(select(func.count()).select_from(SmsTemplate).where(
        SmsTemplate.application_id == ctx.application_id, SmsTemplate.dlt_template_id.is_not(None))) or 0
    country = rd.effective_country(ctx, None)
    return {"consented": {"IN": consented.get("IN", 0), "AE": consented.get("AE", 0), "US": consented.get("US", 0)},
            "dlt_templates": dlt_templates, "default_country": country,
            # UAE: "coming soon" while SMS_UAE_ENABLED is off, with the rules that will apply.
            "coming_soon": uae.sms_blocked(country), "market_rules": list(UAE_SMS_RULES) if country == "AE" else [],
            "uae_attested": uae_attested(dlt_row(db, ctx.application_id))}

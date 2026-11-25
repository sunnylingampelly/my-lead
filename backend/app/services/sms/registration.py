"""DLT / 10DLC registration, sender IDs and SMS templates."""
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import User
from app.models.sms import SmsCampaign, SmsDltConfiguration, SmsSender, SmsTemplate
from app.schemas.sms import DltConfigIn, DltConfigOut, SenderIn, TemplateIn, TemplateOut, TemplateUpdate
from app.services import audit_service, uae
from app.services.email import render
from app.services.sms import rules
from app.services.tenancy import AppContext
from app.utils.time import utcnow

# ------------------------------------------------------------------ DLT / 10DLC


def dlt_row(db: Session, application_id: str) -> SmsDltConfiguration | None:
    return db.scalar(select(SmsDltConfiguration).where(SmsDltConfiguration.application_id == application_id))


def dlt_out(db: Session, row: SmsDltConfiguration | None) -> DltConfigOut:
    if row is None:
        return DltConfigOut(principal_entity_id=None, entity_name=None, dlt_platform=None, us_brand_id=None,
                            us_campaign_id=None, attested_at=None, uae_attested_at=None)
    out = DltConfigOut.model_validate(row)
    if row.attested_by_id:
        u = db.get(User, row.attested_by_id)
        out.attested_by_name = (u.full_name or u.email) if u else None
    if row.uae_attested_by_id:
        u = db.get(User, row.uae_attested_by_id)
        out.uae_attested_by_name = (u.full_name or u.email) if u else None
    return out


def get_dlt(db: Session, ctx: AppContext) -> DltConfigOut:
    ctx.require(Perm.SETTINGS_READ)
    return dlt_out(db, dlt_row(db, ctx.application_id))


def update_dlt(db: Session, ctx: AppContext, data: DltConfigIn) -> DltConfigOut:
    ctx.require(Perm.SETTINGS_WRITE)
    row = dlt_row(db, ctx.application_id)
    if row is None:
        row = SmsDltConfiguration(organization_id=ctx.organization_id, application_id=ctx.application_id)
        db.add(row)
    fields = ("principal_entity_id", "entity_name", "dlt_platform", "us_brand_id", "us_campaign_id")
    changed = False
    for f in fields:
        v = getattr(data, f)
        v = v.strip() or None if isinstance(v, str) else v
        if getattr(row, f) != v:
            setattr(row, f, v)
            changed = True
    if data.attest:
        if not (row.principal_entity_id or row.us_brand_id):
            raise ValidationFailed("Enter a DLT Principal Entity ID or a 10DLC brand ID before confirming",
                                   code="NOTHING_TO_ATTEST")
        row.attested_by_id, row.attested_at = ctx.user.id, utcnow()
    elif changed:
        # Changed registration details must be confirmed again.
        row.attested_by_id = row.attested_at = None
    if data.uae_attest is True:
        # UAE: "we are UAE-licensed and have uploaded our consents to TDRA's CMS" (who and when is kept).
        row.uae_attested_by_id, row.uae_attested_at = ctx.user.id, utcnow()
    elif data.uae_attest is False:
        row.uae_attested_by_id = row.uae_attested_at = None
    db.flush()
    audit_service.record(db, "sms.registration_updated", actor_user_id=ctx.user.id,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="sms_registration", target_id=row.id,
                         meta={"attested": bool(data.attest), "fields_changed": changed,
                               **({"uae_attested": data.uae_attest, "uae_statement": uae.ATTESTATION_TEXT}
                                  if data.uae_attest is not None else {})})
    return dlt_out(db, row)


# ------------------------------------------------------------------ senders


def _sender(db: Session, ctx, sender_id: str) -> SmsSender:
    s = db.scalar(select(SmsSender).where(SmsSender.id == sender_id, SmsSender.application_id == ctx.application_id))
    if s is None:
        raise NotFound("Sender ID not found")
    return s


def list_senders(db: Session, ctx: AppContext) -> list[SmsSender]:
    ctx.require(Perm.CAMPAIGNS_READ)
    return list(db.scalars(select(SmsSender).where(SmsSender.application_id == ctx.application_id)
                           .order_by(SmsSender.is_default.desc(), SmsSender.created_at)))


def create_sender(db: Session, ctx: AppContext, data: SenderIn) -> SmsSender:
    ctx.require(Perm.SETTINGS_WRITE)
    blocked = uae.sms_blocked(data.country)
    if blocked:
        raise ValidationFailed(blocked, code="UAE_SMS_COMING_SOON")
    err = rules.validate_sender(data.country, data.kind, data.sender_id)
    if err:
        raise ValidationFailed(err, code="INVALID_SENDER_ID", details=[{"field": "sender_id", "message": err}])
    if db.scalar(select(SmsSender.id).where(SmsSender.application_id == ctx.application_id,
                                            SmsSender.sender_id == data.sender_id)):
        raise Conflict(f"{data.sender_id} is already added", code="SENDER_EXISTS")
    first = not db.scalar(select(func.count()).select_from(SmsSender).where(
        SmsSender.application_id == ctx.application_id))
    s = SmsSender(organization_id=ctx.organization_id, application_id=ctx.application_id, sender_id=data.sender_id,
                  country=data.country, kind=data.kind, provider=data.provider, dlt_header_id=data.dlt_header_id,
                  status="pending", is_default=bool(first))
    db.add(s)
    db.flush()
    audit_service.record(db, "sms.sender_created", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_sender", target_id=s.id,
                         summary=s.sender_id)
    return s


def attest_sender(db: Session, ctx: AppContext, sender_id: str) -> SmsSender:
    """A team member confirms the header / number is registered and approved for this business."""
    ctx.require(Perm.SETTINGS_WRITE)
    s = _sender(db, ctx, sender_id)
    s.status, s.attested_by_id, s.attested_at = "active", ctx.user.id, utcnow()
    audit_service.record(db, "sms.sender_attested", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_sender", target_id=s.id,
                         summary=s.sender_id)
    return s


def make_default(db: Session, ctx: AppContext, sender_id: str) -> SmsSender:
    ctx.require(Perm.SETTINGS_WRITE)
    s = _sender(db, ctx, sender_id)
    db.execute(update(SmsSender).where(SmsSender.application_id == ctx.application_id).values(is_default=False))
    s.is_default = True
    return s


def delete_sender(db: Session, ctx: AppContext, sender_id: str) -> None:
    ctx.require(Perm.SETTINGS_WRITE)
    s = _sender(db, ctx, sender_id)
    busy = db.scalar(select(SmsCampaign.id).where(SmsCampaign.sender_ref == s.id,
                                                  SmsCampaign.status.in_(("scheduled", "queued", "sending", "paused"))))
    if busy:
        raise Conflict("This sender is used by a scheduled or active campaign", code="SENDER_IN_USE")
    db.delete(s)
    audit_service.record(db, "sms.sender_deleted", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="sms_sender", target_id=sender_id,
                         summary=s.sender_id)


# ------------------------------------------------------------------ templates


def template_row(db: Session, ctx, template_id: str) -> SmsTemplate:
    t = db.scalar(select(SmsTemplate).where(SmsTemplate.id == template_id,
                                            SmsTemplate.application_id == ctx.application_id))
    if t is None:
        raise NotFound("Template not found")
    return t


def template_out(t: SmsTemplate) -> TemplateOut:
    out = TemplateOut.model_validate(t)
    out.dlt_match = rules.matches_dlt(t.body, t.dlt_template_text) if t.dlt_template_text else None
    return out


def _validate_template(db: Session, ctx, body: str | None, sender_ref: str | None, custom: set[str]) -> None:
    if sender_ref:
        _sender(db, ctx, sender_ref)
    if body is not None:
        issues = render.check([body], custom)
        unknown = [u for u in issues.unknown] + [v for v in render.variables_in(body) if v in render.SYSTEM_VARIABLES]
        if unknown or issues.malformed:
            raise ValidationFailed("Fix the personalisation fields: " + ", ".join(unknown + issues.malformed),
                                   code="INVALID_VARIABLES")


def list_templates(db: Session, ctx: AppContext) -> list[TemplateOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    rows = db.scalars(select(SmsTemplate).where(SmsTemplate.application_id == ctx.application_id)
                      .order_by(SmsTemplate.updated_at.desc()))
    return [template_out(t) for t in rows]


def create_template(db: Session, ctx: AppContext, data: TemplateIn, custom: set[str]) -> TemplateOut:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    _validate_template(db, ctx, data.body, data.sender_ref, custom)
    t = SmsTemplate(organization_id=ctx.organization_id, application_id=ctx.application_id,
                    created_by_id=ctx.user.id, **data.model_dump())
    db.add(t)
    db.flush()
    return template_out(t)


def update_template(db: Session, ctx: AppContext, template_id: str, data: TemplateUpdate, custom: set[str]
                    ) -> TemplateOut:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    t = template_row(db, ctx, template_id)
    changes = data.model_dump(exclude_unset=True)
    _validate_template(db, ctx, changes.get("body"), changes.get("sender_ref"), custom)
    for k, v in changes.items():
        if k in ("name", "body", "category") and v is None:
            continue
        setattr(t, k, v)
    db.flush()
    return template_out(t)


def delete_template(db: Session, ctx: AppContext, template_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    db.delete(template_row(db, ctx, template_id))

"""SMS endpoints, scoped to /apps/{app_id}/sms."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, Field

from app.api.deps import DB, AppCtx
from app.core.config import settings
from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Perm
from app.schemas.common import Page, PageParams
from app.schemas.email import Audience, Estimate, ScheduleRequest
from app.schemas.sms import (
    CampaignCreate,
    CampaignListItem,
    CampaignOut,
    CampaignUpdate,
    DltConfigIn,
    DltConfigOut,
    InboundSim,
    MessageOut,
    SenderIn,
    SenderOut,
    TemplateIn,
    TemplateOut,
    TemplateUpdate,
    TestSend,
)
from app.services.email.campaigns import custom_keys
from app.services.email.readiness import safe_commit, wallet_info
from app.services.sms import campaigns, registration, rules
from app.services.sms.encoding import analyse
from app.services.uae import SMS_GLOBAL_COMING_SOON


def _sms_enabled(request: Request) -> None:
    """SMS is "coming soon" everywhere while settings.SMS_ENABLED is off: every write/action is refused;
    read-only GETs still answer. The DLT registration (PUT /registration) stays open: Indian voice calls use the
    same TRAI DLT registration (Voice → Registration); its SMS-only part (the UAE SMS attestation) is refused
    in update_registration."""
    if request.method in ("GET", "HEAD", "OPTIONS") or settings.SMS_ENABLED:
        return
    if request.method == "PUT" and request.url.path.endswith("/registration"):
        return
    raise ValidationFailed(SMS_GLOBAL_COMING_SOON, code="SMS_COMING_SOON")


router = APIRouter(prefix="/apps/{app_id}/sms", tags=["SMS"], dependencies=[Depends(_sms_enabled)])
Paging = Annotated[PageParams, Depends()]


@router.get("/overview")
def overview(ctx: AppCtx, db: DB):
    return campaigns.overview(db, ctx)


class AnalyseBody(BaseModel):
    text: str = Field(default="", max_length=2000)
    country: str | None = Field(default=None, max_length=2)
    category: str = "promotional"
    append_opt_out: bool = False


@router.post("/analyse")
def analyse_text(body: AnalyseBody, ctx: AppCtx):
    """Segment count, encoding and per-message price for a draft text (with sample personalisation)."""
    ctx.require(Perm.CAMPAIGNS_READ)
    shape = campaigns.message_shape(body.text, country=body.country, category=body.category,
                                    append_opt_out=body.append_opt_out)
    unit, currency = rules.price(body.country, body.category)
    return {**shape, "unit_price": unit, "currency": currency, "dlt_pattern": rules.to_dlt_pattern(body.text),
            "raw": analyse(body.text).__dict__}


@router.get("/pricing")
def pricing(ctx: AppCtx):
    ctx.require(Perm.CAMPAIGNS_READ)
    return {"per_segment": settings.SMS_PRICING, "live": settings.COMMUNICATION_MODE == "live"}


# ------------------------------------------------------------------ registration


@router.get("/registration", response_model=DltConfigOut)
def get_registration(ctx: AppCtx, db: DB):
    return registration.get_dlt(db, ctx)


@router.put("/registration", response_model=DltConfigOut)
def update_registration(body: DltConfigIn, ctx: AppCtx, db: DB):
    if body.uae_attest is not None and not settings.SMS_ENABLED:  # SMS-only (UAE TDRA) attestation
        raise ValidationFailed(SMS_GLOBAL_COMING_SOON, code="SMS_COMING_SOON")
    out = registration.update_dlt(db, ctx, body)
    db.commit()
    return out


# ------------------------------------------------------------------ senders


@router.get("/senders", response_model=list[SenderOut])
def list_senders(ctx: AppCtx, db: DB):
    return registration.list_senders(db, ctx)


@router.post("/senders", response_model=SenderOut, status_code=status.HTTP_201_CREATED)
def create_sender(body: SenderIn, ctx: AppCtx, db: DB):
    s = registration.create_sender(db, ctx, body)
    db.commit()
    return s


@router.post("/senders/{sender_id}/attest", response_model=SenderOut)
def attest_sender(sender_id: str, ctx: AppCtx, db: DB):
    s = registration.attest_sender(db, ctx, sender_id)
    db.commit()
    return s


@router.post("/senders/{sender_id}/default", response_model=SenderOut)
def default_sender(sender_id: str, ctx: AppCtx, db: DB):
    s = registration.make_default(db, ctx, sender_id)
    db.commit()
    return s


@router.delete("/senders/{sender_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sender(sender_id: str, ctx: AppCtx, db: DB):
    registration.delete_sender(db, ctx, sender_id)
    db.commit()


# ------------------------------------------------------------------ templates


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(ctx: AppCtx, db: DB):
    return registration.list_templates(db, ctx)


@router.post("/templates", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(body: TemplateIn, ctx: AppCtx, db: DB):
    t = registration.create_template(db, ctx, body, custom_keys(db, ctx.application_id))
    db.commit()
    return t


@router.get("/templates/{template_id}", response_model=TemplateOut)
def get_template(template_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CAMPAIGNS_READ)
    return registration.template_out(registration.template_row(db, ctx, template_id))


@router.patch("/templates/{template_id}", response_model=TemplateOut)
def update_template(template_id: str, body: TemplateUpdate, ctx: AppCtx, db: DB):
    t = registration.update_template(db, ctx, template_id, body, custom_keys(db, ctx.application_id))
    db.commit()
    return t


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(template_id: str, ctx: AppCtx, db: DB):
    registration.delete_template(db, ctx, template_id)
    db.commit()


# ------------------------------------------------------------------ campaigns


@router.get("/campaigns", response_model=Page[CampaignListItem])
def list_campaigns(ctx: AppCtx, db: DB, paging: Paging, status_: str | None = Query(None, alias="status", max_length=20),
                   search: str | None = Query(None, max_length=100)):
    return campaigns.list_campaigns(db, ctx, paging, status_, search)


@router.post("/campaigns", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
def create_campaign(body: CampaignCreate, ctx: AppCtx, db: DB):
    c = campaigns.create_campaign(db, ctx, body)
    db.commit()
    return campaigns.to_out(db, c)


class EstimateBody(Audience):
    country: str | None = Field(default=None, max_length=2)


@router.post("/campaigns/estimate", response_model=Estimate)
def estimate_audience(body: EstimateBody, ctx: AppCtx, db: DB):
    ctx.require(Perm.CAMPAIGNS_READ)
    return campaigns.estimate(db, ctx, body.model_dump(exclude={"country"}), body.country)


@router.get("/campaigns/{campaign_id}", response_model=CampaignOut)
def get_campaign(campaign_id: str, ctx: AppCtx, db: DB):
    return campaigns.get_campaign(db, ctx, campaign_id)


@router.patch("/campaigns/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: str, body: CampaignUpdate, ctx: AppCtx, db: DB):
    c = campaigns.update_campaign(db, ctx, campaign_id, body)
    safe_commit(db, "the campaign")
    return campaigns.to_out(db, c)


@router.delete("/campaigns/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_campaign(campaign_id: str, ctx: AppCtx, db: DB):
    campaigns.delete_campaign(db, ctx, campaign_id)
    db.commit()


@router.post("/campaigns/{campaign_id}/duplicate", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
def duplicate_campaign(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.duplicate_campaign(db, ctx, campaign_id)
    db.commit()
    return campaigns.to_out(db, c)


@router.get("/campaigns/{campaign_id}/readiness")
def readiness(campaign_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CAMPAIGNS_READ)
    c = campaigns._get(db, ctx, campaign_id)
    checks, est = campaigns.readiness(db, ctx, c)
    # Before a sender is chosen, price and rules follow the application's home market.
    sender, country = campaigns.country_of(db, ctx, c)
    shape = campaigns.message_shape(c.body, country=country, category=c.category, append_opt_out=c.append_opt_out)
    cost = campaigns.cost_estimate(est.eligible if est else 0, shape["segments"], country, c.category)
    return {"ready": all(ch.ok or ch.warning for ch in checks), "checks": [ch.model_dump() for ch in checks],
            "estimate": est.model_dump() if est else None, "message": shape, "cost": cost,
            "country": country, "sender_chosen": sender is not None,
            "wallet": wallet_info(db, ctx.organization_id),
            "quiet_hours": campaigns.quiet_wait(db, ctx, c, country),
            "custom_keys": sorted(custom_keys(db, ctx.application_id))}


@router.get("/campaigns/{campaign_id}/recipients/ids")
def recipient_ids(campaign_id: str, ctx: AppCtx, db: DB,
                  status_: str | None = Query(None, alias="status", max_length=20)):
    """Contact ids behind a report tab (delivered, not_delivered, replied, opted_out…), max 5000."""
    return campaigns.recipient_ids(db, ctx, campaign_id, status_)


class PreviewBody(BaseModel):
    contact_id: str | None = Field(default=None, max_length=36)
    body: str | None = Field(default=None, max_length=2000)


@router.post("/campaigns/{campaign_id}/preview")
def preview(campaign_id: str, body: PreviewBody, ctx: AppCtx, db: DB):
    return campaigns.preview(db, ctx, campaign_id, body.contact_id, body.body)


@router.post("/campaigns/{campaign_id}/test")
def send_test(campaign_id: str, body: TestSend, ctx: AppCtx, db: DB):
    out = campaigns.send_test(db, ctx, campaign_id, body)
    db.commit()
    return out


@router.post("/campaigns/{campaign_id}/schedule", response_model=CampaignOut)
def schedule(campaign_id: str, body: ScheduleRequest, ctx: AppCtx, db: DB):
    c = campaigns.schedule(db, ctx, campaign_id, body)
    db.commit()
    return campaigns.to_out(db, c)


@router.post("/campaigns/{campaign_id}/unschedule", response_model=CampaignOut)
def unschedule(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.unschedule(db, ctx, campaign_id)
    db.commit()
    return campaigns.to_out(db, c)


@router.post("/campaigns/{campaign_id}/send", response_model=CampaignOut)
def send_now(campaign_id: str, ctx: AppCtx, db: DB):
    return campaigns.to_out(db, campaigns.send_now(db, ctx, campaign_id))


@router.post("/campaigns/{campaign_id}/pause", response_model=CampaignOut)
def pause(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.pause(db, ctx, campaign_id)
    db.commit()
    return campaigns.to_out(db, c)


@router.post("/campaigns/{campaign_id}/resume", response_model=CampaignOut)
def resume(campaign_id: str, ctx: AppCtx, db: DB):
    return campaigns.to_out(db, campaigns.resume(db, ctx, campaign_id))


@router.post("/campaigns/{campaign_id}/cancel", response_model=CampaignOut)
def cancel(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.cancel(db, ctx, campaign_id)
    db.commit()
    return campaigns.to_out(db, c)


@router.get("/campaigns/{campaign_id}/report")
def report(campaign_id: str, ctx: AppCtx, db: DB):
    return campaigns.report(db, ctx, campaign_id)


@router.get("/campaigns/{campaign_id}/messages", response_model=Page[MessageOut])
def messages(campaign_id: str, ctx: AppCtx, db: DB, paging: Paging,
             status_: str | None = Query(None, alias="status", max_length=20),
             search: str | None = Query(None, max_length=40)):
    return campaigns.list_messages(db, ctx, campaign_id, paging, status_, search)


# ------------------------------------------------------------------ inbound


@router.get("/inbound")
def list_inbound(ctx: AppCtx, db: DB, paging: Paging):
    ctx.require(Perm.CAMPAIGNS_READ)
    from sqlalchemy import func, select

    from app.models import Contact
    from app.models.sms import SmsCampaign, SmsInbound
    from app.utils.contact_normalize import mask_phone

    q = select(SmsInbound).where(SmsInbound.application_id == ctx.application_id)
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = list(db.scalars(q.order_by(SmsInbound.received_at.desc()).offset(paging.offset)
                           .limit(paging.page_size)))
    contacts = {c.id: c for c in db.scalars(select(Contact).where(
        Contact.id.in_({r.contact_id for r in rows if r.contact_id}), Contact.application_id == ctx.application_id))}
    camps = dict(db.execute(select(SmsCampaign.id, SmsCampaign.name).where(
        SmsCampaign.id.in_({r.campaign_id for r in rows if r.campaign_id}))).all())

    def contact_out(cid):
        c = contacts.get(cid)
        if c is None:
            return None
        return {"id": c.id, "name": c.full_name or c.email or mask_phone(c.phone or ""), "email": c.email,
                "owner_id": getattr(c, "owner_id", None)}

    return {"items": [{"id": r.id, "from": mask_phone(r.from_phone), "to": r.to_sender, "body": r.body,
                       "keyword": r.keyword, "contacts_updated": r.contacts_updated,
                       "received_at": r.received_at.isoformat(), "contact": contact_out(r.contact_id),
                       "campaign": {"id": r.campaign_id, "name": camps[r.campaign_id]}
                       if r.campaign_id in camps else None} for r in rows],
            "total": total, "page": paging.page, "page_size": paging.page_size}


@router.post("/simulate-inbound")
def simulate_inbound(body: InboundSim, ctx: AppCtx, db: DB):
    """Simulation mode only: pretend a contact replied (for example STOP) to one of this app's senders."""
    if settings.COMMUNICATION_MODE == "live":
        raise NotFound()
    ctx.require(Perm.CAMPAIGNS_WRITE)
    from app.services.sms import inbound

    rows = inbound.handle(db, from_phone=body.from_phone, to_sender=body.to_sender, body=body.body,
                          provider="simulation", event_id=body.event_id, application_ids=[ctx.application_id])
    db.commit()
    if not rows:
        raise NotFound("No sender ID with that value in this application, or the reply was already recorded")
    return {"keyword": rows[0].keyword, "contacts_updated": rows[0].contacts_updated}

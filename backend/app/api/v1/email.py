"""Email endpoints, scoped to /apps/{app_id}/email."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import JSONResponse

from app.api.deps import DB, AppCtx
from app.core.permissions import Perm
from app.schemas.common import Page, PageParams
from app.schemas.email import (
    Audience,
    CampaignCreate,
    CampaignListItem,
    CampaignOut,
    CampaignUpdate,
    Estimate,
    MessageOut,
    PreviewOut,
    PreviewRequest,
    ScheduleRequest,
    SenderCreate,
    SenderOut,
    SenderUpdate,
    TemplateBody,
    TemplateOut,
    TemplateUpdate,
    TestSendRequest,
    dump_with_design,
    without_design,
)
from app.services.email import campaigns, render, senders, templates
from app.services.email.campaigns import custom_keys
from app.services.email.readiness import safe_commit, wallet_info

router = APIRouter(prefix="/apps/{app_id}/email", tags=["Email"])
Paging = Annotated[PageParams, Depends()]


def _tpl(t) -> TemplateOut:
    return without_design(TemplateOut, t)


def _out(out, status_code: int = 200) -> JSONResponse:
    """Campaign/template responses carry the raw visual-editor design (see schemas.email.without_design)."""
    body = [dump_with_design(o) for o in out] if isinstance(out, list) else dump_with_design(out)
    return JSONResponse(body, status_code=status_code)


@router.get("/overview")
def overview(ctx: AppCtx, db: DB):
    return campaigns.overview(db, ctx)


@router.get("/variables")
def variables(ctx: AppCtx, db: DB):
    """Personalisation fields available in subjects and content."""
    ctx.require(Perm.CAMPAIGNS_READ)
    from sqlalchemy import select

    from app.models import ContactAttributeDefinition

    custom = db.execute(select(ContactAttributeDefinition.key, ContactAttributeDefinition.label).where(
        ContactAttributeDefinition.application_id == ctx.application_id).order_by(ContactAttributeDefinition.label)).all()
    return {
        "core": [{"key": k, "label": v} for k, v in render.CORE_VARIABLES.items()],
        "custom": [{"key": k, "label": label} for k, label in custom],
        "system": [{"key": k, "label": v} for k, v in render.SYSTEM_VARIABLES.items()],
    }


# ------------------------------------------------------------------ senders

@router.get("/senders", response_model=list[SenderOut])
def list_senders(ctx: AppCtx, db: DB):
    return senders.list_senders(db, ctx)


@router.post("/senders", response_model=SenderOut, status_code=status.HTTP_201_CREATED)
def create_sender(body: SenderCreate, ctx: AppCtx, db: DB):
    out = senders.create_sender(db, ctx, body)
    db.commit()
    return out


@router.patch("/senders/{sender_id}", response_model=SenderOut)
def update_sender(sender_id: str, body: SenderUpdate, ctx: AppCtx, db: DB):
    out = senders.update_sender(db, ctx, sender_id, body)
    db.commit()
    return out


@router.post("/senders/{sender_id}/resend", response_model=SenderOut)
def resend_sender(sender_id: str, ctx: AppCtx, db: DB):
    return senders.resend_verification(db, ctx, sender_id)


@router.delete("/senders/{sender_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sender(sender_id: str, ctx: AppCtx, db: DB):
    senders.delete_sender(db, ctx, sender_id)
    db.commit()


@router.get("/senders/{sender_id}/tips")
def sender_tips(sender_id: str, ctx: AppCtx, db: DB):
    s = senders._get(db, ctx, sender_id)
    return {"tips": senders.deliverability_tips(s.from_email), "domain": s.from_email.split("@", 1)[1]}


# ------------------------------------------------------------------ templates

@router.get("/templates", response_model=list[TemplateOut])
def list_templates(ctx: AppCtx, db: DB):
    return _out([_tpl(t) for t in templates.list_templates(db, ctx)])


@router.post("/templates", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(body: TemplateBody, ctx: AppCtx, db: DB):
    t = templates.create_template(db, ctx, body)
    db.commit()
    return _out(_tpl(t), 201)


@router.get("/templates/{template_id}", response_model=TemplateOut)
def get_template(template_id: str, ctx: AppCtx, db: DB):
    return _out(_tpl(templates.get_template(db, ctx, template_id)))


@router.patch("/templates/{template_id}", response_model=TemplateOut)
def update_template(template_id: str, body: TemplateUpdate, ctx: AppCtx, db: DB):
    t = templates.update_template(db, ctx, template_id, body)
    safe_commit(db, "the template")
    return _out(_tpl(t))


@router.post("/templates/{template_id}/duplicate", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def duplicate_template(template_id: str, ctx: AppCtx, db: DB):
    t = templates.duplicate_template(db, ctx, template_id)
    db.commit()
    return _out(_tpl(t), 201)


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(template_id: str, ctx: AppCtx, db: DB):
    templates.delete_template(db, ctx, template_id)
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
    return _out(campaigns.to_out(db, c), 201)


@router.post("/campaigns/estimate", response_model=Estimate)
def estimate_audience(body: Audience, ctx: AppCtx, db: DB):
    ctx.require(Perm.CAMPAIGNS_READ)
    return campaigns.estimate(db, ctx, body.model_dump())


@router.get("/campaigns/{campaign_id}", response_model=CampaignOut)
def get_campaign(campaign_id: str, ctx: AppCtx, db: DB):
    return _out(campaigns.get_campaign(db, ctx, campaign_id))


@router.patch("/campaigns/{campaign_id}", response_model=CampaignOut)
def update_campaign(campaign_id: str, body: CampaignUpdate, ctx: AppCtx, db: DB):
    c = campaigns.update_campaign(db, ctx, campaign_id, body)
    safe_commit(db, "the campaign")
    return _out(campaigns.to_out(db, c))


@router.delete("/campaigns/{campaign_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_campaign(campaign_id: str, ctx: AppCtx, db: DB):
    campaigns.delete_campaign(db, ctx, campaign_id)
    db.commit()


@router.post("/campaigns/{campaign_id}/duplicate", response_model=CampaignOut, status_code=status.HTTP_201_CREATED)
def duplicate_campaign(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.duplicate_campaign(db, ctx, campaign_id)
    db.commit()
    return _out(campaigns.to_out(db, c), 201)


@router.get("/campaigns/{campaign_id}/readiness")
def readiness(campaign_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CAMPAIGNS_READ)
    c = campaigns._get(db, ctx, campaign_id)
    checks, est = campaigns.readiness(db, ctx, c)
    from app.services.billing import wallet as wl

    country = ctx.application.default_country if ctx.application else None
    price, cur = wl.email_price(country)
    eligible = est.eligible if est else 0
    return {"ready": all(ch.ok for ch in checks), "checks": [ch.model_dump() for ch in checks],
            "estimate": est.model_dump() if est else None,
            "cost": {"unit_price": float(price), "currency": cur, "total": round(float(price) * eligible, 2)},
            "wallet": wallet_info(db, ctx.organization_id),
            "custom_keys": sorted(custom_keys(db, ctx.application_id))}


@router.get("/campaigns/{campaign_id}/recipients/ids")
def recipient_ids(campaign_id: str, ctx: AppCtx, db: DB,
                  status_: str | None = Query(None, alias="status", max_length=20)):
    """Contact ids behind a report tab (opened, clicked, not_opened, bounced, unsubscribed…), max 5000."""
    return campaigns.recipient_ids(db, ctx, campaign_id, status_)


@router.post("/campaigns/{campaign_id}/preview", response_model=PreviewOut)
def preview(campaign_id: str, body: PreviewRequest, ctx: AppCtx, db: DB):
    return campaigns.preview(db, ctx, campaign_id, body)


@router.post("/campaigns/{campaign_id}/test")
def send_test(campaign_id: str, body: TestSendRequest, ctx: AppCtx, db: DB):
    out = campaigns.send_test(db, ctx, campaign_id, body)
    db.commit()
    return out


@router.post("/campaigns/{campaign_id}/schedule", response_model=CampaignOut)
def schedule(campaign_id: str, body: ScheduleRequest, ctx: AppCtx, db: DB):
    c = campaigns.schedule(db, ctx, campaign_id, body)
    db.commit()
    return _out(campaigns.to_out(db, c))


@router.post("/campaigns/{campaign_id}/unschedule", response_model=CampaignOut)
def unschedule(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.unschedule(db, ctx, campaign_id)
    db.commit()
    return _out(campaigns.to_out(db, c))


@router.post("/campaigns/{campaign_id}/send", response_model=CampaignOut)
def send_now(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.send_now(db, ctx, campaign_id)
    return _out(campaigns.to_out(db, c))


@router.post("/campaigns/{campaign_id}/pause", response_model=CampaignOut)
def pause(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.pause(db, ctx, campaign_id)
    db.commit()
    return _out(campaigns.to_out(db, c))


@router.post("/campaigns/{campaign_id}/resume", response_model=CampaignOut)
def resume(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.resume(db, ctx, campaign_id)
    return _out(campaigns.to_out(db, c))


@router.post("/campaigns/{campaign_id}/cancel", response_model=CampaignOut)
def cancel(campaign_id: str, ctx: AppCtx, db: DB):
    c = campaigns.cancel(db, ctx, campaign_id)
    db.commit()
    return _out(campaigns.to_out(db, c))


@router.get("/campaigns/{campaign_id}/report")
def report(campaign_id: str, ctx: AppCtx, db: DB):
    return campaigns.report(db, ctx, campaign_id)


@router.get("/campaigns/{campaign_id}/messages", response_model=Page[MessageOut])
def messages(campaign_id: str, ctx: AppCtx, db: DB, paging: Paging,
             status_: str | None = Query(None, alias="status", max_length=20),
             search: str | None = Query(None, max_length=200)):
    return campaigns.list_messages(db, ctx, campaign_id, paging, status_, search)

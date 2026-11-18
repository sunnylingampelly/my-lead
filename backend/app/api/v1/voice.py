"""Voice endpoints, scoped to /apps/{app_id}/voice."""
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from pydantic import Field

from app.api.deps import DB, AppCtx
from app.core.config import settings
from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.schemas.common import Page, PageParams
from app.schemas.email import Audience, Estimate, ScheduleRequest
from app.schemas.voice import (
    AudioOut,
    AudioUpdate,
    CallerIn,
    CallerOut,
    CallOut,
    CampaignCreate,
    CampaignListItem,
    CampaignOut,
    CampaignUpdate,
    TestCall,
    TtsIn,
)
from app.services.voice import campaigns, library, rules, script

router = APIRouter(prefix="/apps/{app_id}/voice", tags=["Voice"])
Paging = Annotated[PageParams, Depends()]


@router.get("/overview")
def overview(ctx: AppCtx, db: DB):
    return campaigns.overview(db, ctx)


@router.get("/options")
def options(ctx: AppCtx):
    """Languages, calling windows, pricing and upload limits for the UI."""
    ctx.require(Perm.CAMPAIGNS_READ)
    return {"languages": rules.LANGUAGES, "legal_windows": rules.LEGAL_WINDOW, "pricing": settings.VOICE_PRICING,
            "opt_out_digit": rules.OPT_OUT_DIGIT, **library.max_upload_info()}


# ------------------------------------------------------------------ caller IDs


@router.get("/callers", response_model=list[CallerOut])
def list_callers(ctx: AppCtx, db: DB):
    return library.list_callers(db, ctx)


@router.get("/provider-numbers")
def provider_numbers(ctx: AppCtx, provider: str = Query("telnyx", max_length=20)):
    """Numbers already bought on the platform's Telnyx account, to add as caller IDs."""
    ctx.require(Perm.SETTINGS_WRITE)
    if provider != "telnyx" or not settings.TELNYX_API_KEY:
        return {"configured": False, "numbers": []}
    from app.providers.voice.telnyx import list_numbers

    try:
        return {"configured": True, "numbers": list_numbers(settings.TELNYX_API_KEY)}
    except Exception as exc:  # noqa: BLE001
        raise ValidationFailed("Could not load numbers from Telnyx. Check the API key.",
                               code="PROVIDER_ERROR") from exc


@router.post("/callers", response_model=CallerOut, status_code=status.HTTP_201_CREATED)
def create_caller(body: CallerIn, ctx: AppCtx, db: DB):
    c = library.create_caller(db, ctx, body)
    db.commit()
    return c


@router.post("/callers/{caller_id}/attest", response_model=CallerOut)
def attest_caller(caller_id: str, ctx: AppCtx, db: DB):
    c = library.attest_caller(db, ctx, caller_id)
    db.commit()
    return c


@router.post("/callers/{caller_id}/default", response_model=CallerOut)
def default_caller(caller_id: str, ctx: AppCtx, db: DB):
    c = library.make_default(db, ctx, caller_id)
    db.commit()
    return c


@router.delete("/callers/{caller_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_caller(caller_id: str, ctx: AppCtx, db: DB):
    library.delete_caller(db, ctx, caller_id)
    db.commit()


# ------------------------------------------------------------------ audio library


@router.get("/audio", response_model=list[AudioOut])
def list_audio(ctx: AppCtx, db: DB):
    return library.list_audio(db, ctx)


@router.post("/audio/upload", response_model=AudioOut, status_code=status.HTTP_201_CREATED)
async def upload_audio(ctx: AppCtx, db: DB, file: UploadFile = File(...), name: str = Form("", max_length=120)):
    data = await file.read(library.MAX_AUDIO_BYTES + 1)
    if len(data) > library.MAX_AUDIO_BYTES:
        raise ValidationFailed("Recordings can be up to 5 MB", code="FILE_TOO_LARGE")
    out = library.upload_audio(db, ctx, name or (file.filename or "Recording").rsplit(".", 1)[0], data)
    db.commit()
    return out


@router.post("/audio/tts", response_model=AudioOut, status_code=status.HTTP_201_CREATED)
def create_tts(body: TtsIn, ctx: AppCtx, db: DB):
    out = library.create_tts(db, ctx, body)
    db.commit()
    return out


@router.patch("/audio/{audio_id}", response_model=AudioOut)
def update_audio(audio_id: str, body: AudioUpdate, ctx: AppCtx, db: DB):
    out = library.update_audio(db, ctx, audio_id, body)
    db.commit()
    return out


@router.delete("/audio/{audio_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_audio(audio_id: str, ctx: AppCtx, db: DB):
    library.delete_audio(db, ctx, audio_id)
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
    db.commit()
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
    caller = campaigns.caller_of(db, c)
    country = caller.country if caller else None
    snap = campaigns.draft_snapshot(db, c)
    seconds = script.estimated_seconds(snap) if snap else 0
    return {"ready": all(ch.ok for ch in checks), "checks": [ch.model_dump() for ch in checks],
            "estimate": est.model_dump() if est else None, "seconds": seconds,
            "cost": campaigns.cost_estimate(est.eligible if est else 0, seconds, country),
            "window": rules.LEGAL_WINDOW.get(country or "", rules.DEFAULT_WINDOW)}


@router.get("/campaigns/{campaign_id}/preview")
def preview(campaign_id: str, ctx: AppCtx, db: DB, contact_id: str | None = Query(None, max_length=36)):
    return campaigns.preview(db, ctx, campaign_id, contact_id)


@router.post("/campaigns/{campaign_id}/test")
def test_call(campaign_id: str, body: TestCall, ctx: AppCtx, db: DB):
    out = campaigns.test_call(db, ctx, campaign_id, body)
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


@router.get("/campaigns/{campaign_id}/calls", response_model=Page[CallOut])
def calls(campaign_id: str, ctx: AppCtx, db: DB, paging: Paging,
          status_: str | None = Query(None, alias="status", max_length=20),
          search: str | None = Query(None, max_length=40)):
    return campaigns.list_calls(db, ctx, campaign_id, paging, status_, search)

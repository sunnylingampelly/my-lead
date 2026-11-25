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
    CallOut,
    CampaignCreate,
    CampaignListItem,
    CampaignOut,
    CampaignUpdate,
    TestCall,
    TtsIn,
)
from app.schemas.voice_ai import (
    AgentCreate,
    AgentEvaluate,
    AgentListItem,
    AgentOut,
    AgentTest,
    AgentUpdate,
)
from app.services.email.readiness import safe_commit, wallet_info
from app.services.voice import agents, ai, campaigns, library, rules, script

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
            "ai_pricing": settings.VOICE_AI_PRICING, "ai_expected_minutes": settings.AI_CALL_EXPECTED_MINUTES,
            "opt_out_digit": rules.OPT_OUT_DIGIT, **library.max_upload_info()}


# ------------------------------------------------------------------ AI agents


@router.get("/ai/status")
def ai_status(ctx: AppCtx):
    ctx.require(Perm.CAMPAIGNS_READ)
    return {"configured": ai.configured(), "model": settings.AI_AGENT_MODEL}


@router.get("/agents/templates")
def agent_templates(ctx: AppCtx):
    ctx.require(Perm.CAMPAIGNS_READ)
    return agents.templates()


@router.get("/agents", response_model=list[AgentListItem])
def list_agents(ctx: AppCtx, db: DB):
    return agents.list_agents(db, ctx)


@router.post("/agents", response_model=AgentOut, status_code=status.HTTP_201_CREATED)
def create_agent(body: AgentCreate, ctx: AppCtx, db: DB):
    a = agents.create_agent(db, ctx, body)
    db.commit()
    return agents.agent_out(db, a)


@router.get("/agents/{agent_id}", response_model=AgentOut)
def get_agent(agent_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CAMPAIGNS_READ)
    return agents.agent_out(db, agents.agent_row(db, ctx, agent_id))


@router.patch("/agents/{agent_id}", response_model=AgentOut)
def update_agent(agent_id: str, body: AgentUpdate, ctx: AppCtx, db: DB):
    a = agents.update_agent(db, ctx, agent_id, body)
    db.commit()
    return agents.agent_out(db, a)


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_agent(agent_id: str, ctx: AppCtx, db: DB):
    agents.delete_agent(db, ctx, agent_id)
    db.commit()


@router.post("/agents/{agent_id}/duplicate", response_model=AgentOut, status_code=status.HTTP_201_CREATED)
def duplicate_agent(agent_id: str, ctx: AppCtx, db: DB):
    a = agents.duplicate_agent(db, ctx, agent_id)
    db.commit()
    return agents.agent_out(db, a)


@router.post("/agents/{agent_id}/activate", response_model=AgentOut)
def activate_agent(agent_id: str, ctx: AppCtx, db: DB):
    a = agents.set_status(db, ctx, agent_id, True)
    db.commit()
    return agents.agent_out(db, a)


@router.post("/agents/{agent_id}/deactivate", response_model=AgentOut)
def deactivate_agent(agent_id: str, ctx: AppCtx, db: DB):
    a = agents.set_status(db, ctx, agent_id, False)
    db.commit()
    return agents.agent_out(db, a)


def _test_values(db, ctx, body) -> dict:
    first = body.contact.first_name if body.contact else None
    return ai.values_for(first or "Asha", campaigns.business_name(db, ctx))


@router.post("/agents/{agent_id}/test")
def test_agent(agent_id: str, body: AgentTest, ctx: AppCtx, db: DB):
    """One turn of the browser test chat (the user plays the customer). Uses no wallet credit."""
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = agents.agent_row(db, ctx, agent_id)
    msgs = [m.model_dump() for m in body.messages]
    out = ai.reply_sync(agents.snapshot(a), msgs, _test_values(db, ctx, body))
    return {"reply": out["text"], "end_call": out["end"], "transfer": out["transfer"], "simulated": out["simulated"],
            "error": out["error"]}


@router.post("/agents/{agent_id}/test/evaluate")
def evaluate_agent(agent_id: str, body: AgentEvaluate, ctx: AppCtx, db: DB):
    """What a real call would capture from this conversation (summary, interest, outcome fields)."""
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = agents.agent_row(db, ctx, agent_id)
    transcript = [{"role": m.role, "text": m.content} for m in body.messages]
    try:
        return ai.extract(agents.snapshot(a), transcript, _test_values(db, ctx, body))
    except Exception as exc:  # noqa: BLE001 - rate limits, outages: tell the user to retry
        raise ValidationFailed("The AI service couldn't review this conversation right now. Try again.",
                               code="AI_UNAVAILABLE") from exc


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
    # Calls go to the application's market from Signalcraft-managed numbers.
    _, country = campaigns.country_of(db, ctx, c)
    snap = campaigns.draft_snapshot(db, c)
    seconds = script.estimated_seconds(snap) if snap else 0
    calling = campaigns.calling_window(db, ctx, c, country)
    return {"ready": all(ch.ok for ch in checks), "checks": [ch.model_dump() for ch in checks],
            "estimate": est.model_dump() if est else None, "seconds": seconds,
            "cost": campaigns.cost_estimate(est.eligible if est else 0, seconds, country, ai=campaigns.is_ai(db, c)),
            "country": country,
            "window": rules.window_for(country),  # legal window (kept for older clients)
            "calling_hours": calling, "wallet": wallet_info(db, ctx.organization_id)}


@router.get("/campaigns/{campaign_id}/recipients/ids")
def recipient_ids(campaign_id: str, ctx: AppCtx, db: DB,
                  status_: str | None = Query(None, alias="status", max_length=20)):
    """Contact ids behind a report tab (completed, voicemail, opted_out = pressed 9, not_answered…), max 5000."""
    return campaigns.recipient_ids(db, ctx, campaign_id, status_)


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


@router.get("/campaigns/{campaign_id}/calls/{call_id}")
def call_detail(campaign_id: str, call_id: str, ctx: AppCtx, db: DB):
    """One call, with the AI conversation transcript, summary and captured outcomes."""
    return campaigns.call_detail(db, ctx, campaign_id, call_id)

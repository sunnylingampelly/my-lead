"""AI Team endpoints: the assistant (/apps/{app_id}/ai/assistant…), confirmation of proposed actions, AI agents
and their runs, approvals, and the Slack integration. Slack's own callbacks (OAuth redirect, interactivity) are
public and verified separately (see slack_public below)."""
import json
from typing import Any, Literal
from urllib.parse import parse_qs

from fastapi import APIRouter, Query, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.api.deps import DB, AppCtx
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import Unauthorized, ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.models import User
from app.services.ai_team import actions, agents, assistant, llm, runner, slack, tools, usage
from app.services.ai_team.registry import ToolError
from app.services.ai_team.templates import EVENTS, listing

log = get_logger(__name__)
router = APIRouter(prefix="/apps/{app_id}/ai", tags=["AI Team"])
slack_public = APIRouter(prefix="/integrations/slack", tags=["AI Team"])


def _tool_error(exc: ToolError):
    raise ValidationFailed(exc.message, code=exc.code, details={"link": exc.link} if exc.link else None) from exc


# ------------------------------------------------------------------ status


@router.get("/status")
def ai_status(ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_USE)
    return {"simulated": not llm.configured(), "model": llm.model_for() if llm.configured() else None,
            "usage": usage.summary(db, ctx.organization_id), "pending_approvals": actions.pending_count(db, ctx),
            "can_manage": ctx.has(Perm.AI_MANAGE), "slack": slack.status(db, ctx)}


@router.get("/tools")
def tool_catalog(ctx: AppCtx):
    ctx.require(Perm.AI_USE)
    return [t for t in tools.catalog(ctx) if t["name"] in agents.agent_tools()]


# ------------------------------------------------------------------ assistant


class PageContext(BaseModel):
    path: str | None = Field(default=None, max_length=300)
    title: str | None = Field(default=None, max_length=200)
    contact_id: str | None = Field(default=None, max_length=36)
    deal_id: str | None = Field(default=None, max_length=36)
    campaign_id: str | None = Field(default=None, max_length=36)
    form_id: str | None = Field(default=None, max_length=36)
    workflow_id: str | None = Field(default=None, max_length=36)
    bot_id: str | None = Field(default=None, max_length=36)
    agent_id: str | None = Field(default=None, max_length=36)


class AskBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    conversation_id: str | None = Field(default=None, max_length=36)
    page: PageContext | None = None


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'), default=str)}\n\n"


@router.get("/conversations")
def conversations(ctx: AppCtx, db: DB):
    return assistant.list_conversations(db, ctx)


@router.post("/conversations", status_code=status.HTTP_201_CREATED)
def new_conversation(ctx: AppCtx, db: DB):
    c = assistant.new_conversation(db, ctx)
    db.commit()
    return assistant.conv_out(c)


@router.get("/conversations/{conv_id}")
def conversation(conv_id: str, ctx: AppCtx, db: DB):
    return assistant.conversation_detail(db, ctx, conv_id)


@router.delete("/conversations/{conv_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(conv_id: str, ctx: AppCtx, db: DB):
    assistant.delete_conversation(db, ctx, conv_id)
    db.commit()
    return Response(status_code=204)


@router.post("/assistant/messages")
def ask(body: AskBody, ctx: AppCtx, db: DB):
    """Ask the assistant. The answer streams back as server-sent events: conversation, meta (simulated), delta…,
    tool, action (a confirmation card), done (the stored message and today's usage) or error."""
    page = body.page.model_dump(exclude_none=True) if body.page else None
    conv, _ = assistant.start(db, ctx, body.conversation_id, body.text, page)  # 422 AI_DAILY_LIMIT before streaming
    user_id, app_id, conv_id = ctx.user.id, ctx.application_id, conv.id

    def stream():
        from app.services.tenancy import resolve_app_context

        with SessionLocal() as s:
            try:
                c2 = resolve_app_context(s, s.get(User, user_id), app_id)
                cv = assistant.get_conversation(s, c2, conv_id)
                for kind, data in assistant.reply_events(s, c2, cv, page):
                    yield _sse(kind, data)
            except llm.LlmError as exc:
                s.rollback()
                yield _sse("error", {"message": str(exc)})
            except Exception:  # noqa: BLE001 - the stream must end cleanly
                s.rollback()
                log.exception("assistant_reply_failed", conversation_id=conv_id)
                yield _sse("error", {"message": "Sorry, something went wrong. Please try again."})
        yield _sse("end", {})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})


class ConfirmBody(BaseModel):
    args: dict[str, Any] | None = None


@router.get("/actions/{action_id}")
def get_action(action_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_USE)
    return actions.card(actions.get(db, ctx, action_id))


@router.post("/actions/{action_id}/confirm")
def confirm_action(action_id: str, ctx: AppCtx, db: DB, body: ConfirmBody | None = None):
    """Run a proposed write. Idempotent: confirming twice returns the same result and never runs it twice."""
    try:
        a = actions.decide(db, ctx, action_id, True, edits=(body.args if body else None))
    except ToolError as exc:
        _tool_error(exc)
    return actions.card(a)


@router.post("/actions/{action_id}/cancel")
def cancel_action(action_id: str, ctx: AppCtx, db: DB):
    return actions.card(actions.decide(db, ctx, action_id, False))


# ------------------------------------------------------------------ approvals


@router.get("/approvals")
def approvals(ctx: AppCtx, db: DB, status_: Literal["pending", "decided"] = Query("pending", alias="status")):
    return actions.list_pending(db, ctx, "pending" if status_ == "pending" else "decided")


@router.post("/approvals/{action_id}/approve")
def approve(action_id: str, ctx: AppCtx, db: DB, body: ConfirmBody | None = None):
    try:
        a = actions.decide(db, ctx, action_id, True, edits=(body.args if body else None))
    except ToolError as exc:
        _tool_error(exc)
    return actions.card(a)


@router.post("/approvals/{action_id}/reject")
def reject(action_id: str, ctx: AppCtx, db: DB):
    return actions.card(actions.decide(db, ctx, action_id, False))


# ------------------------------------------------------------------ agents


class AgentBody(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    template: str | None = Field(default=None, max_length=40)
    instructions: str | None = Field(default=None, max_length=4000)
    trigger: dict[str, Any] | None = None
    allowed_tools: list[str] | None = Field(default=None, max_length=40)
    mode: Literal["auto", "approve"] | None = None
    destinations: dict[str, Any] | None = None
    enabled: bool | None = None


class DraftBody(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)


class RunBody(BaseModel):
    dry_run: bool = False


@router.get("/agents/templates")
def agent_templates(ctx: AppCtx):
    ctx.require(Perm.AI_USE)
    return {"templates": listing(), "events": [{"key": k, "label": v} for k, v in EVENTS.items()]}


@router.get("/agents")
def list_agents(ctx: AppCtx, db: DB):
    return agents.list_agents(db, ctx)


@router.post("/agents/draft")
def draft_agent(body: DraftBody, ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_MANAGE)
    return agents.draft_from_prompt(db, ctx, body.prompt)


@router.post("/agents", status_code=status.HTTP_201_CREATED)
def create_agent(body: AgentBody, ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_MANAGE)
    cfg = agents.from_template(body.template) if body.template and not body.name else {}
    cfg.update(body.model_dump(exclude_none=True))
    a = agents.create_agent(db, ctx, cfg)
    db.commit()
    return agents.out(db, a)


@router.get("/agents/{agent_id}")
def get_agent(agent_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_USE)
    return agents.out(db, agents.get(db, ctx, agent_id))


@router.patch("/agents/{agent_id}")
def update_agent(agent_id: str, body: AgentBody, ctx: AppCtx, db: DB):
    changes = body.model_dump(exclude_none=True)
    enabled = changes.pop("enabled", None)
    a = agents.update_agent(db, ctx, agent_id, changes) if changes else agents.get(db, ctx, agent_id)
    if enabled is not None:
        a = agents.set_enabled(db, ctx, agent_id, enabled)
    db.commit()
    return agents.out(db, a)


@router.delete("/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_agent(agent_id: str, ctx: AppCtx, db: DB):
    agents.delete_agent(db, ctx, agent_id)
    db.commit()
    return Response(status_code=204)


@router.post("/agents/{agent_id}/run", status_code=status.HTTP_202_ACCEPTED)
def run_agent(agent_id: str, body: RunBody, ctx: AppCtx, db: DB):
    """Run now (or a dry run: write tools are only described). Poll the run for its steps."""
    run = runner.run_now(db, ctx, agent_id, body.dry_run)
    db.commit()
    from app.tasks.ai_team import run_agent as task

    try:
        task.delay(run.id)
    except Exception:  # noqa: BLE001 - the minute tick picks it up if the broker is down
        log.warning("ai_run_enqueue_failed", run_id=run.id)
    db.expire_all()
    return runner.run_detail(db, ctx, run.id)


@router.get("/agents/{agent_id}/runs")
def agent_runs(agent_id: str, ctx: AppCtx, db: DB):
    return runner.list_runs(db, ctx, agent_id)


@router.get("/runs/{run_id}")
def run_detail(run_id: str, ctx: AppCtx, db: DB):
    return runner.run_detail(db, ctx, run_id)


# ------------------------------------------------------------------ Slack


@router.get("/integrations/slack")
def slack_status(ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_USE)
    return slack.status(db, ctx)


@router.post("/integrations/slack/install")
def slack_install(ctx: AppCtx):
    return {"url": slack.install_url(ctx)}


@router.post("/integrations/slack/simulate")
def slack_simulate(ctx: AppCtx, db: DB):
    slack.connect_simulated(db, ctx)
    db.commit()
    return slack.status(db, ctx)


@router.delete("/integrations/slack", status_code=status.HTTP_204_NO_CONTENT)
def slack_disconnect(ctx: AppCtx, db: DB):
    slack.disconnect(db, ctx)
    db.commit()
    return Response(status_code=204)


@router.get("/integrations/slack/channels")
def slack_channels(ctx: AppCtx, db: DB):
    ctx.require(Perm.AI_USE)
    try:
        return slack.list_channels(db, ctx.organization_id)
    except ToolError as exc:
        _tool_error(exc)


@slack_public.get("/oauth/callback", include_in_schema=False)
def slack_oauth_callback(db: DB, code: str | None = Query(None, max_length=500),
                         state: str | None = Query(None, max_length=2000), error: str | None = Query(None, max_length=100)):
    """Slack redirects the browser here after "Add to Slack"; the signed state names the org, app and user."""
    return RedirectResponse(slack.oauth_callback(db, code, state, error), status_code=302)


@slack_public.post("/interactivity", include_in_schema=False)
async def slack_interactivity(request: Request):
    """Button clicks (Approve / Reject). Verified with the signing secret (v0 HMAC, 5-minute window)."""
    body = await request.body()
    if len(body) > 100_000 or not slack.verify_signature(request.headers.get("x-slack-request-timestamp"),
                                                         request.headers.get("x-slack-signature"), body):
        raise Unauthorized("Invalid Slack signature", code="INVALID_SIGNATURE")
    try:
        payload = json.loads(parse_qs(body.decode("utf-8")).get("payload", ["{}"])[0])
    except (ValueError, UnicodeDecodeError):
        return JSONResponse({}, status_code=200)
    if not isinstance(payload, dict):
        return JSONResponse({}, status_code=200)
    def handle() -> dict:
        with SessionLocal() as db:
            return slack.handle_interaction(db, payload)

    result = await run_in_threadpool(handle)
    # Slack shows nothing from this body for block_actions; the clicker got an ephemeral reply via response_url.
    return JSONResponse({"ok": result["ok"]} if settings.ENVIRONMENT != "production" else {}, status_code=200)

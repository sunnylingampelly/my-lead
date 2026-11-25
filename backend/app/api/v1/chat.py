"""Website chatbots and live chat for the team: bots and their training, the test chat, the live-chat inbox,
agents and presence, canned responses and analytics."""
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, File, Query, UploadFile, status

from app.api.deps import DB, AppCtx
from app.core.config import settings
from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.schemas.chat import (
    AgentAdd,
    AgentReply,
    AssignBody,
    BotCreate,
    BotTest,
    BotUpdate,
    CannedIn,
    ImproveAnswer,
    PresenceBody,
    SourceCreate,
    SourceUpdate,
    TagsBody,
)
from app.schemas.common import PageParams
from app.services.chat import ai, analytics, billing, bots, conversations, inbox, knowledge
from app.services.email.readiness import safe_commit

router = APIRouter(prefix="/apps/{app_id}/chat", tags=["Chat"])


def _parse_ts(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00").replace(" ", "+"))
    except ValueError as exc:
        raise ValidationFailed("Invalid timestamp") from exc


# ------------------------------------------------------------------ bots


@router.get("/status")
def chat_status(ctx: AppCtx, db: DB):
    """Whether Claude is configured (otherwise replies are simulated and free) and the price per AI reply."""
    ctx.require(Perm.CHAT_READ)
    row = billing.price_row(ctx.application.default_country)
    return {**ai.status(), "price": {"per_reply": row["per_reply"], "currency": row["currency"]},
            "inline_limit": settings.CHAT_KNOWLEDGE_INLINE_CHARS, "max_chars": settings.CHAT_KNOWLEDGE_MAX_CHARS,
            "crawl_max_pages": settings.CHAT_CRAWL_MAX_PAGES}


@router.get("/templates")
def bot_templates(ctx: AppCtx):
    ctx.require(Perm.CHAT_READ)
    return bots.templates()


@router.get("/bots")
def list_bots(ctx: AppCtx, db: DB):
    return bots.list_bots(db, ctx)


@router.post("/bots", status_code=status.HTTP_201_CREATED)
def create_bot(body: BotCreate, ctx: AppCtx, db: DB):
    b = bots.create_bot(db, ctx, body)
    db.commit()
    return bots.bot_out(db, b)


@router.get("/bots/{bot_id}")
def get_bot(bot_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CHAT_READ)
    return bots.bot_out(db, knowledge.bot_row(db, ctx, bot_id))


@router.patch("/bots/{bot_id}")
def update_bot(bot_id: str, body: BotUpdate, ctx: AppCtx, db: DB):
    b = bots.update_bot(db, ctx, bot_id, body)
    safe_commit(db, "the chatbot")
    return bots.bot_out(db, b)


@router.delete("/bots/{bot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_bot(bot_id: str, ctx: AppCtx, db: DB):
    bots.delete_bot(db, ctx, bot_id)
    db.commit()


@router.post("/bots/{bot_id}/publish")
def publish_bot(bot_id: str, ctx: AppCtx, db: DB):
    b = bots.set_status(db, ctx, bot_id, True)
    db.commit()
    return bots.bot_out(db, b)


@router.post("/bots/{bot_id}/unpublish")
def unpublish_bot(bot_id: str, ctx: AppCtx, db: DB):
    b = bots.set_status(db, ctx, bot_id, False)
    db.commit()
    return bots.bot_out(db, b)


@router.post("/bots/{bot_id}/test")
def test_bot(bot_id: str, body: BotTest, ctx: AppCtx, db: DB):
    """One reply in the test chat (the user plays the visitor). Uses no wallet credit."""
    ctx.require(Perm.CHAT_READ)
    b = knowledge.bot_row(db, ctx, bot_id)
    history = [{"role": "visitor" if m.role == "user" else "bot", "body": m.content} for m in body.messages]
    question = next((m["body"] for m in reversed(history) if m["role"] == "visitor"), "")
    text, need = knowledge.inline_knowledge(db, b)
    retrieved = knowledge.retrieve(db, b, question) if need and question else None
    kb = knowledge.simulated_kb(db, b, question) if not ai.configured() else None
    context = {"lead_captured": False, "agents_online": conversations.agents_available(db, b)}
    parts, outcome = [], ("error", "empty")
    for kind, val in ai.stream_reply(bots.snapshot(db, b), history, text, retrieved, context, kb):
        if kind == "text":
            parts.append(str(val))
        else:
            outcome = (kind, val)
    reply, markers = ai.clean("".join(parts))
    kind, info = outcome
    error = None
    if kind == "refusal":
        reply, markers, error = ai.REFUSAL_LINE, set(), "refusal"
    elif kind == "error":
        reply, markers, error = ai.ERROR_LINE, set(), str(info)
    return {"reply": reply, "question": question, "simulated": kind == "done" and bool(info.get("simulated")),
            "unanswered": ai.UNANSWERED in markers, "handoff": ai.HANDOFF in markers,
            "collect_contact": ai.COLLECT in markers, "error": error,
            "knowledge_mode": "retrieval" if need else "inline",
            "retrieved": [{"title": c["title"], "preview": c["content"][:200]} for c in (retrieved or [])]}


# ------------------------------------------------------------------ training


@router.get("/bots/{bot_id}/sources")
def list_sources(bot_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CHAT_READ)
    b = knowledge.bot_row(db, ctx, bot_id)
    return [knowledge.source_out(s) for s in knowledge.sources(db, b.id)]


@router.post("/bots/{bot_id}/sources", status_code=status.HTTP_201_CREATED)
def add_source(bot_id: str, body: SourceCreate, ctx: AppCtx, db: DB, background: BackgroundTasks):
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    s = knowledge.add_source(db, ctx, b, body)
    safe_commit(db, "the training source")
    if s.kind == "url":
        background.add_task(knowledge.sync_source_job, s.id)
    return knowledge.source_out(s)


@router.post("/bots/{bot_id}/sources/upload", status_code=status.HTTP_201_CREATED)
async def upload_source(bot_id: str, ctx: AppCtx, db: DB, file: UploadFile = File(...)):
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    data = await file.read(settings.CHAT_UPLOAD_MAX_BYTES + 1)
    s = knowledge.add_file(db, ctx, b, file.filename or "upload.txt", data)
    safe_commit(db, "the file")
    return knowledge.source_out(s)


@router.get("/bots/{bot_id}/sources/{source_id}")
def get_source(bot_id: str, source_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CHAT_READ)
    b = knowledge.bot_row(db, ctx, bot_id)
    return knowledge.source_out(knowledge.source_row(db, b, source_id), full=True)


@router.patch("/bots/{bot_id}/sources/{source_id}")
def update_source(bot_id: str, source_id: str, body: SourceUpdate, ctx: AppCtx, db: DB):
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    s = knowledge.update_source(db, b, source_id, body)
    safe_commit(db, "the training source")
    return knowledge.source_out(s)


@router.delete("/bots/{bot_id}/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_source(bot_id: str, source_id: str, ctx: AppCtx, db: DB):
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    knowledge.delete_source(db, b, source_id)
    db.commit()


@router.post("/bots/{bot_id}/sources/{source_id}/resync")
def resync_source(bot_id: str, source_id: str, ctx: AppCtx, db: DB, background: BackgroundTasks):
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    s = knowledge.resync(db, b, source_id)
    db.commit()
    if s.kind == "url":
        background.add_task(knowledge.sync_source_job, s.id)
    return knowledge.source_out(s)


@router.post("/bots/{bot_id}/improve", status_code=status.HTTP_201_CREATED)
def improve_answer(bot_id: str, body: ImproveAnswer, ctx: AppCtx, db: DB):
    """Teach the bot the right answer: saved as a FAQ whose question is what the visitor asked."""
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    s = knowledge.improve(db, ctx, b, body)
    safe_commit(db, "the answer")
    return knowledge.source_out(s)


# ------------------------------------------------------------------ inbox


@router.get("/inbox/conversations")
def inbox_list(ctx: AppCtx, db: DB, params: Annotated[PageParams, Depends()],
               filter: str = Query("open", max_length=20), q: str | None = Query(None, max_length=100),
               bot_id: str | None = Query(None, max_length=36)):
    return inbox.list_conversations(db, ctx, params, filter, q, bot_id)


@router.get("/inbox/updates")
def inbox_updates(ctx: AppCtx, db: DB, since: str | None = Query(None, max_length=40)):
    return inbox.updates(db, ctx, _parse_ts(since))


@router.get("/inbox/conversations/{conv_id}")
def inbox_detail(conv_id: str, ctx: AppCtx, db: DB):
    return inbox.detail(db, ctx, conv_id)


@router.get("/inbox/conversations/{conv_id}/messages")
def inbox_messages(conv_id: str, ctx: AppCtx, db: DB, after: str | None = Query(None, max_length=40)):
    return inbox.messages(db, ctx, conv_id, _parse_ts(after))


@router.post("/inbox/conversations/{conv_id}/join")
def inbox_join(conv_id: str, ctx: AppCtx, db: DB):
    inbox.join(db, ctx, conv_id)
    db.commit()
    return inbox.detail(db, ctx, conv_id)


@router.post("/inbox/conversations/{conv_id}/messages", status_code=status.HTTP_201_CREATED)
def inbox_reply(conv_id: str, body: AgentReply, ctx: AppCtx, db: DB):
    m = inbox.reply(db, ctx, conv_id, body.body, body.internal)
    db.commit()
    return inbox.message_out(m, {ctx.user.id: ctx.user})


@router.post("/inbox/conversations/{conv_id}/assign")
def inbox_assign(conv_id: str, body: AssignBody, ctx: AppCtx, db: DB):
    inbox.assign(db, ctx, conv_id, body.user_id)
    db.commit()
    return inbox.detail(db, ctx, conv_id)


@router.post("/inbox/conversations/{conv_id}/tags")
def inbox_tags(conv_id: str, body: TagsBody, ctx: AppCtx, db: DB):
    inbox.set_tags(db, ctx, conv_id, body.tags)
    db.commit()
    return {"tags": body.tags}


@router.post("/inbox/conversations/{conv_id}/close")
def inbox_close(conv_id: str, ctx: AppCtx, db: DB, background: BackgroundTasks):
    inbox.close(db, ctx, conv_id)
    db.commit()
    background.add_task(conversations.process_closed_job, conv_id)
    return inbox.detail(db, ctx, conv_id)


@router.post("/inbox/conversations/{conv_id}/reopen")
def inbox_reopen(conv_id: str, ctx: AppCtx, db: DB):
    inbox.reopen(db, ctx, conv_id)
    db.commit()
    return inbox.detail(db, ctx, conv_id)


@router.post("/inbox/conversations/{conv_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def inbox_read(conv_id: str, ctx: AppCtx, db: DB):
    inbox.mark_read(db, ctx, conv_id)
    db.commit()


# ------------------------------------------------------------------ agents and presence


@router.post("/presence")
def presence(body: PresenceBody, ctx: AppCtx, db: DB):
    out = inbox.heartbeat(db, ctx, body.status)
    db.commit()
    return out


@router.get("/agents")
def list_agents(ctx: AppCtx, db: DB):
    return inbox.agents_out(db, ctx)


@router.post("/agents", status_code=status.HTTP_201_CREATED)
def add_agent(body: AgentAdd, ctx: AppCtx, db: DB):
    inbox.manage_add(db, ctx, body.user_id)
    db.commit()
    return inbox.agents_out(db, ctx)


@router.delete("/agents/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_agent(user_id: str, ctx: AppCtx, db: DB):
    inbox.manage_remove(db, ctx, user_id)
    db.commit()


# ------------------------------------------------------------------ canned responses


@router.get("/canned")
def list_canned(ctx: AppCtx, db: DB):
    return inbox.list_canned(db, ctx)


@router.post("/canned", status_code=status.HTTP_201_CREATED)
def create_canned(body: CannedIn, ctx: AppCtx, db: DB):
    r = inbox.save_canned(db, ctx, body)
    db.commit()
    return inbox.canned_out(r)


@router.patch("/canned/{canned_id}")
def update_canned(canned_id: str, body: CannedIn, ctx: AppCtx, db: DB):
    r = inbox.save_canned(db, ctx, body, canned_id)
    db.commit()
    return inbox.canned_out(r)


@router.delete("/canned/{canned_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_canned(canned_id: str, ctx: AppCtx, db: DB):
    inbox.delete_canned(db, ctx, canned_id)
    db.commit()


# ------------------------------------------------------------------ analytics


@router.get("/analytics")
def chat_analytics(ctx: AppCtx, db: DB, days: int = Query(30, ge=1, le=365),
                   bot_id: str | None = Query(None, max_length=36)):
    return analytics.overview(db, ctx, days, bot_id)


@router.get("/unanswered")
def chat_unanswered(ctx: AppCtx, db: DB, bot_id: str | None = Query(None, max_length=36)):
    return analytics.unanswered(db, ctx, None, bot_id)

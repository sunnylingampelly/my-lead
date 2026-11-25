"""Public API for the website chat widget (called from customers' websites through the widget iframe).

Every call is treated as hostile:
* the bot is found by its public key, and only live bots answer (drafts only for previews on our own origin);
* the calling website must be in the bot's allowed domains (`origin_allowed`): the browser's Origin header, or,
  for calls from our own widget iframe, the embedding page's origin the widget reports;
* visitors authenticate with an HMAC-signed visitor token (X-Visitor-Token) and can only reach their own
  conversations;
* rate limits per IP, per visitor and per bot; message length caps (schemas).
"""
import json
import time
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Header, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy import select

from app.api.deps import DB
from app.core.config import settings
from app.core.database import SessionLocal
from app.core.embed import host_of, origin_allowed
from app.core.errors import Forbidden, NotFound, RateLimited, Unauthorized
from app.core.logging import get_logger
from app.core.rate_limit import _get_backend, client_ip
from app.models.chat import ChatBot, ChatConversation, ChatVisitor
from app.schemas.chat import (
    HostIn,
    LeadIn,
    OfflineIn,
    PageInfo,
    RatingIn,
    TranscriptIn,
    VisitorIn,
    VisitorMessage,
)
from app.services.chat import bots, conversations
from app.services.chat import inbox as inbox_svc
from app.utils.time import utcnow

log = get_logger(__name__)
router = APIRouter(prefix="/public/chat/{public_key}", tags=["Chat widget (public)"])
Token = Annotated[str | None, Header(alias="X-Visitor-Token", max_length=120)]


# ------------------------------------------------------------------ guards


def _hit(key: str, limit: int, window: int = 60) -> None:
    if not settings.RATE_LIMIT_ENABLED:
        return
    bucket = int(time.time() // window)
    if _get_backend().hit(f"rl:chat:{key}:{bucket}", window) > limit:
        raise RateLimited("Too many requests. Please wait a moment and try again.")


def _own(host: str | None) -> bool:
    h = host_of(host)
    return bool(h) and h in {host_of(settings.FRONTEND_URL), host_of(settings.BACKEND_PUBLIC_URL)}


def _site(request: Request, reported: str | None) -> str | None:
    """The website the widget runs on: the Origin header, or (from our own iframe) the origin it reports."""
    origin = request.headers.get("origin")
    if origin and not _own(origin):
        return origin
    return reported or origin


def load_bot(db, request: Request, public_key: str, host: str | None = None) -> ChatBot:
    if len(public_key) > 40:
        raise NotFound("Chat not found")
    bot = db.scalar(select(ChatBot).where(ChatBot.public_key == public_key))
    site = _site(request, host)
    if bot is None or (bot.status != "live" and not _own(site)):
        raise NotFound("This chat isn't available")
    # Browsers always send Origin on cross-site calls; our own iframe's same-origin GETs may omit it, and then
    # the embedding page's origin it reports is checked instead (the iframe itself is protected by CSP
    # frame-ancestors). Non-browser clients can forge either, so this is an abuse guard, not authentication.
    origin = request.headers.get("origin")
    for candidate in (origin, site):
        if candidate and not origin_allowed(candidate, bot.allowed_domains, empty_means_any=False):
            raise Forbidden("This website isn't allowed to use this chat", code="ORIGIN_NOT_ALLOWED")
    _hit(f"bot:{bot.id}", 3000)
    return bot


def _visitor(db, bot: ChatBot, token: str | None) -> ChatVisitor:
    v = conversations.visitor_from_token(db, bot, token)
    if v is None:
        raise Unauthorized("Your chat session expired. Reload the page to start again.", code="INVALID_VISITOR")
    return v


def _out(db, bot: ChatBot, conv: ChatConversation | None, after=None) -> dict:
    return {"conversation": conversations.conversation_state(db, bot, conv),
            "messages": conversations.visible_messages(db, conv, after) if conv else []}


def public_config(db, bot: ChatBot) -> dict:
    out = bots.bot_out(db, bot, with_counts=False)
    lead = out["lead_capture"]
    appearance = out["appearance"]
    if out["branding_hidden"]:
        appearance["show_branding"] = False
    return {"key": bot.public_key, "name": bot.name, "status": bot.status, "avatar_url": bot.avatar_url,
            "welcome_message": bot.welcome_message, "quick_replies": bot.quick_replies or [],
            "appearance": appearance, "proactive": out["proactive"],
            "lead_capture": {"mode": lead["mode"], "prompt": lead["prompt"], "fields": lead["fields"],
                             "consent": {"enabled": lead["consent"]["enabled"], "text": lead["consent"]["text"]}},
            "agents_online": conversations.agents_available(db, bot),
            "hours_open": inbox_svc.hours_open(bot), "api": f"{settings.API_V1_PREFIX}/public/chat/{bot.public_key}",
            "brand_url": settings.FRONTEND_URL}


# ------------------------------------------------------------------ endpoints


@router.get("/config")
def config(public_key: str, request: Request, db: DB, host: str | None = Query(None, max_length=300)):
    _hit(f"cfg:{client_ip(request)}", 240)
    bot = load_bot(db, request, public_key, host)
    return public_config(db, bot)


@router.post("/visitor")
def visitor(public_key: str, body: VisitorIn, request: Request, db: DB, token: Token = None):
    """Create (or refresh) the visitor. Returns the signed token and the latest conversation, if any."""
    ip = client_ip(request)
    bot = load_bot(db, request, public_key, body.page.host if body.page else None)
    known = conversations.visitor_from_token(db, bot, token) is not None
    _hit(f"visit:{ip}", 120 if known else 30)
    identity = {"name": body.name, "email": body.email, "phone": body.phone, "attributes": body.attributes}
    v, tok, _ = conversations.touch_visitor(db, bot, token, body.page, ip, request.headers.get("user-agent"),
                                            identity if any(identity.values()) else None)
    conv = conversations.latest_conversation(db, bot, v)
    db.commit()
    return {"token": tok, "visitor": {"name": v.name, "email": v.email, "known": v.contact_id is not None},
            **_out(db, bot, conv)}


@router.post("/conversations")
def start_conversation(public_key: str, body: VisitorIn, request: Request, db: DB, token: Token = None):
    bot = load_bot(db, request, public_key, body.page.host if body.page else None)
    v = _visitor(db, bot, token)
    _hit(f"start:{v.id}", 20)
    _hit(f"start-ip:{client_ip(request)}", 60)
    if body.page:
        conversations.track_page(v, body.page)
    conv = conversations.start(db, bot, v, body.page)
    db.commit()
    return _out(db, bot, conv)


@router.get("/conversations/{conv_id}/messages")
def poll_messages(public_key: str, conv_id: str, request: Request, db: DB, token: Token = None,
                  after: str | None = Query(None, max_length=40), host: str | None = Query(None, max_length=300)):
    bot = load_bot(db, request, public_key, host)
    v = _visitor(db, bot, token)
    _hit(f"poll:{v.id}", 150)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    from datetime import datetime

    try:
        ts = datetime.fromisoformat(after.replace(" ", "+")) if after else None
    except ValueError:
        ts = None
    return _out(db, bot, conv, ts)


def _sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


@router.post("/conversations/{conv_id}/messages")
def send_message(public_key: str, conv_id: str, body: VisitorMessage, request: Request, db: DB, token: Token = None):
    """The visitor's message. With stream=true the bot's reply streams back as server-sent events
    (message, delta…, message, state, end); otherwise everything comes back as JSON at once."""
    ip = client_ip(request)
    bot = load_bot(db, request, public_key, body.host)
    v = _visitor(db, bot, token)
    _hit(f"msg:{v.id}", 20)
    _hit(f"msg-ip:{ip}", 40)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    m, answer = conversations.post_visitor_message(db, bot, conv, v, body.text)
    v.last_seen_at = utcnow()
    db.commit()
    first = conversations.public_message(m)
    bot_id, cid = bot.id, conv.id

    def events():
        yield "message", first
        if not answer:
            with SessionLocal() as s:
                b, c = s.get(ChatBot, bot_id), s.get(ChatConversation, cid)
                yield "state", conversations.conversation_state(s, b, c)
            return
        with SessionLocal() as s:
            b, c = s.get(ChatBot, bot_id), s.get(ChatConversation, cid)
            try:
                yield from conversations.reply_events(s, b, c)
            except Exception:
                s.rollback()
                log.exception("chat_reply_failed", conversation_id=cid)
                yield "error", {"message": "Sorry, something went wrong. Please try again."}

    if body.stream:
        def stream():
            for kind, data in events():
                yield _sse(kind, data)
            yield _sse("end", {})

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"})
    msgs, state, error = [], None, None
    for kind, data in events():
        if kind == "message":
            msgs.append(data)
        elif kind == "state":
            state = data
        elif kind == "error":
            error = data["message"]
    return JSONResponse({"messages": msgs, "conversation": state, "error": error})


@router.post("/conversations/{conv_id}/lead")
def submit_lead(public_key: str, conv_id: str, body: LeadIn, request: Request, db: DB, token: Token = None):
    ip = client_ip(request)
    bot = load_bot(db, request, public_key, body.host)
    v = _visitor(db, bot, token)
    _hit(f"lead:{ip}", 10)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    conversations.submit_lead(db, bot, conv, v, body.values, body.consent, ip, _site(request, body.host))
    db.commit()
    return _out(db, bot, conv)


@router.post("/conversations/{conv_id}/handoff")
def handoff(public_key: str, conv_id: str, body: HostIn, request: Request, db: DB, token: Token = None):
    bot = load_bot(db, request, public_key, body.host)
    v = _visitor(db, bot, token)
    _hit(f"handoff:{v.id}", 10)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    conversations.request_handoff(db, bot, conv, by="visitor")
    db.commit()
    return _out(db, bot, conv)


@router.post("/offline")
def offline(public_key: str, body: OfflineIn, request: Request, db: DB, token: Token = None,
            conversation_id: str | None = Query(None, max_length=36)):
    ip = client_ip(request)
    bot = load_bot(db, request, public_key, body.host)
    v = _visitor(db, bot, token)
    _hit(f"offline:{ip}", 6)
    conv = conversations.get_conversation(db, bot, v, conversation_id) if conversation_id else None
    conv = conversations.submit_offline(db, bot, v, conv, body, ip)
    db.commit()
    return _out(db, bot, conv)


@router.post("/conversations/{conv_id}/close")
def close(public_key: str, conv_id: str, body: HostIn, request: Request, db: DB, background: BackgroundTasks,
          token: Token = None):
    bot = load_bot(db, request, public_key, body.host)
    v = _visitor(db, bot, token)
    _hit(f"close:{v.id}", 10)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    conversations.close(db, conv, "visitor")
    db.commit()
    background.add_task(conversations.process_closed_job, conv.id)
    return _out(db, bot, conv)


@router.post("/conversations/{conv_id}/rating")
def rating(public_key: str, conv_id: str, body: RatingIn, request: Request, db: DB, token: Token = None):
    bot = load_bot(db, request, public_key)
    v = _visitor(db, bot, token)
    _hit(f"rate:{v.id}", 10)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    conversations.rate(db, conv, body.rating, body.comment)
    db.commit()
    return _out(db, bot, conv)


@router.post("/conversations/{conv_id}/transcript")
def transcript(public_key: str, conv_id: str, body: TranscriptIn, request: Request, db: DB, token: Token = None):
    bot = load_bot(db, request, public_key)
    v = _visitor(db, bot, token)
    _hit(f"transcript:{v.id}", 3, 3600)
    _hit(f"transcript-ip:{client_ip(request)}", 10, 3600)
    conv = conversations.get_conversation(db, bot, v, conv_id)
    sent = conversations.transcript_email(db, bot, conv, body.email)
    return {"sent": sent}


@router.post("/page")
def page_view(public_key: str, body: PageInfo, request: Request, db: DB, token: Token = None):
    bot = load_bot(db, request, public_key, body.host)
    v = _visitor(db, bot, token)
    _hit(f"page:{v.id}", 60)
    conversations.track_page(v, body)
    v.last_seen_at = utcnow()
    db.commit()
    return {"ok": True}

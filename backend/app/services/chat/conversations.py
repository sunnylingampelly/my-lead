"""Visitor conversations: signed visitor tokens, starting chats, bot replies (streamed, billed), lead capture
into Contacts and the CRM, hand-off to a human, offline messages, closing with an AI summary, ratings and
emailed transcripts.

States: bot (the AI answers) → waiting (a person was requested; the bot stays quiet) → open (an agent
joined) → closed. A visitor can only ever read and write their own conversations: every public call is
authenticated by an HMAC-signed visitor token bound to the bot.
"""
import base64
import hashlib
import hmac
import re
from collections.abc import Iterator
from datetime import timedelta
from html import escape
from urllib.parse import parse_qs, urlparse

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.logging import get_logger
from app.models import Application, Contact, CrmActivity, ScoringRule, User
from app.models.chat import ChatBot, ChatConversation, ChatMessage, ChatVisitor
from app.schemas.chat import LeadCapture, PageInfo
from app.services.chat import ai, billing, knowledge
from app.services.chat.bots import business_name, snapshot
from app.utils.time import utcnow

log = get_logger(__name__)
VISIBLE_ROLES = ("visitor", "bot", "agent", "system")
NO_AI_LINE = ("Our assistant can't answer right now. You can leave your details and our team will get back to "
              "you, or talk to a team member.")


# ------------------------------------------------------------------ visitor tokens


def _key() -> bytes:
    return hashlib.sha256(("chat-visitor-token:" + settings.SECRET_KEY).encode()).digest()


def _sig(bot_id: str, visitor_id: str) -> str:
    mac = hmac.new(_key(), f"{bot_id}:{visitor_id}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")[:43]


def visitor_token(bot_id: str, visitor_id: str) -> str:
    return f"{visitor_id}.{_sig(bot_id, visitor_id)}"


def visitor_from_token(db: Session, bot: ChatBot, token: str | None) -> ChatVisitor | None:
    if not token or "." not in token or len(token) > 120:
        return None
    vid, sig = token.split(".", 1)
    if not hmac.compare_digest(sig, _sig(bot.id, vid)):
        return None
    v = db.get(ChatVisitor, vid)
    return v if v is not None and v.bot_id == bot.id else None


# ------------------------------------------------------------------ visitors


def _utm(url: str | None) -> dict:
    if not url:
        return {}
    try:
        qs = parse_qs(urlparse(url).query)
    except ValueError:
        return {}
    return {k: v[0][:120] for k, v in qs.items() if k.startswith("utm_") and v}


def _safe_url(u: str | None) -> str | None:
    u = (u or "").strip()
    return u[:2000] if re.match(r"^https?://", u, re.I) else None


def track_page(v: ChatVisitor, page: PageInfo | None) -> None:
    if page is None or not _safe_url(page.url):
        return
    url = _safe_url(page.url)
    pages = list(v.pages or [])
    if not pages or pages[-1].get("url") != url:
        pages.append({"url": url, "title": (page.title or "")[:200], "at": utcnow().isoformat()})
    v.pages = pages[-30:]
    if not v.referrer and _safe_url(page.referrer):
        v.referrer = _safe_url(page.referrer)[:1000]
    utm = _utm(url)
    if utm and not v.utm:
        v.utm = utm


def touch_visitor(db: Session, bot: ChatBot, token: str | None, page: PageInfo | None, ip: str | None,
                  user_agent: str | None, identity: dict | None = None) -> tuple[ChatVisitor, str, bool]:
    """The visitor for this token (or a new one). Returns (visitor, token, created)."""
    v = visitor_from_token(db, bot, token)
    created = v is None
    if v is None:
        v = ChatVisitor(organization_id=bot.organization_id, application_id=bot.application_id, bot_id=bot.id,
                        attributes={}, pages=[], utm={}, first_seen_at=utcnow())
        db.add(v)
    v.last_seen_at = utcnow()
    v.ip_address = (ip or "")[:64] or None
    v.user_agent = (user_agent or "")[:400] or None
    track_page(v, page)
    if identity:
        identify(v, identity)
    db.flush()
    return v, visitor_token(bot.id, v.id), created


def identify(v: ChatVisitor, data: dict) -> None:
    """Data the website passes with Signalcraft.chat.identify() / setAttributes(). Trusted no more than the page."""
    if data.get("name"):
        v.name = str(data["name"]).strip()[:200]
    if data.get("email") and re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", str(data["email"]).strip()):
        v.email = str(data["email"]).strip()[:320]
    if data.get("phone"):
        v.phone = re.sub(r"[^\d+]", "", str(data["phone"]))[:40] or None
    if data.get("attributes"):
        v.attributes = {**(v.attributes or {}), **data["attributes"]}
        if len(v.attributes) > 30:
            v.attributes = dict(list(v.attributes.items())[-30:])


# ------------------------------------------------------------------ messages and state


def public_message(m: ChatMessage, agents: dict[str, User] | None = None) -> dict:
    meta = m.meta or {}
    author = (agents or {}).get(m.author_id) if m.author_id else None
    return {"id": m.id, "role": m.role, "body": m.body, "created_at": m.created_at.isoformat(),
            "author": (author.full_name or "").split(" ")[0] or "Team" if author else meta.get("author"),
            "meta": {k: v for k, v in meta.items() if k in ("quick_replies", "form", "simulated", "offer_human",
                                                              "event", "unanswered")}}


def _authors(db: Session, msgs: list[ChatMessage]) -> dict[str, User]:
    ids = {m.author_id for m in msgs if m.author_id}
    return {u.id: u for u in db.scalars(select(User).where(User.id.in_(ids)))} if ids else {}


def add_message(db: Session, conv: ChatConversation, role: str, body: str, *, author_id: str | None = None,
                meta: dict | None = None, question: str | None = None, flag: str | None = None) -> ChatMessage:
    now = utcnow()
    # Keep a strict order even when two messages land in the same microsecond.
    if conv.last_message_at and now <= conv.last_message_at:
        now = conv.last_message_at + timedelta(microseconds=1)
    m = ChatMessage(organization_id=conv.organization_id, application_id=conv.application_id,
                    conversation_id=conv.id, role=role, body=body[:8000], author_id=author_id, meta=meta or {},
                    question=question, flag=flag, created_at=now)
    db.add(m)
    conv.message_count = (conv.message_count or 0) + 1
    conv.last_message_at = now
    if role != "note":
        conv.last_message_preview = re.sub(r"\s+", " ", body)[:200]
    if role == "visitor":
        conv.visitor_messages = (conv.visitor_messages or 0) + 1
        conv.unread_agent = (conv.unread_agent or 0) + 1
    conv.updated_at = now
    db.flush()
    return m


def visible_messages(db: Session, conv: ChatConversation, after=None, limit: int = 200) -> list[dict]:
    q = select(ChatMessage).where(ChatMessage.conversation_id == conv.id, ChatMessage.role.in_(VISIBLE_ROLES))
    if after is not None:
        q = q.where(ChatMessage.created_at > after)
    rows = list(db.scalars(q.order_by(ChatMessage.created_at.desc()).limit(limit)))[::-1]
    agents = _authors(db, rows)
    return [public_message(m, agents) for m in rows]


def lead_policy(bot: ChatBot) -> LeadCapture:
    return LeadCapture.model_validate(bot.lead_capture or {})


def conversation_state(db: Session, bot: ChatBot, conv: ChatConversation | None) -> dict | None:
    if conv is None:
        return None
    agent = db.get(User, conv.assignee_id) if conv.assignee_id and conv.status == "open" else None
    return {"id": conv.id, "status": conv.status, "closed": conv.status == "closed",
            "agent": {"name": (agent.full_name or "Team").split(" ")[0]} if agent else None,
            "lead_captured": conv.lead_captured_at is not None, "rating": conv.rating, "offline": conv.offline,
            "agents_online": agents_available(db, bot)}


def agents_available(db: Session, bot: ChatBot) -> bool:
    from app.services.chat import inbox

    return inbox.hours_open(bot) and bool(inbox.online_agents(db, bot.application_id))


# ------------------------------------------------------------------ public flows


def get_conversation(db: Session, bot: ChatBot, visitor: ChatVisitor, conversation_id: str) -> ChatConversation:
    c = db.get(ChatConversation, conversation_id)
    if c is None or c.bot_id != bot.id or c.visitor_id != visitor.id:
        raise NotFound("Conversation not found")
    return c


def latest_conversation(db: Session, bot: ChatBot, visitor: ChatVisitor) -> ChatConversation | None:
    return db.scalar(select(ChatConversation).where(ChatConversation.bot_id == bot.id,
                                                    ChatConversation.visitor_id == visitor.id)
                     .order_by(ChatConversation.created_at.desc()).limit(1))


def start(db: Session, bot: ChatBot, visitor: ChatVisitor, page: PageInfo | None) -> ChatConversation:
    """The visitor's open conversation, or a new one opened with the welcome message."""
    current = latest_conversation(db, bot, visitor)
    if current is not None and current.status != "closed":
        return current
    url = _safe_url(page.url) if page else None
    conv = ChatConversation(organization_id=bot.organization_id, application_id=bot.application_id, bot_id=bot.id,
                            visitor_id=visitor.id, contact_id=visitor.contact_id, status="bot", tags=[],
                            page_url=url, page_title=((page.title or "")[:300] or None) if page else None)
    db.add(conv)
    db.flush()
    policy = lead_policy(bot)
    meta: dict = {"quick_replies": list(bot.quick_replies or [])}
    if policy.mode == "before" and visitor.contact_id is None:
        meta["form"] = "lead_required"
    add_message(db, conv, "bot", bot.welcome_message or "Hi! How can I help you today?", meta=meta)
    conv.unread_agent = 0
    return conv


def post_visitor_message(db: Session, bot: ChatBot, conv: ChatConversation, visitor: ChatVisitor, text: str
                         ) -> tuple[ChatMessage, bool]:
    """Store a visitor message. Returns (message, whether the bot should answer it)."""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text).strip()
    if not text:
        raise ValidationFailed("Type a message", code="EMPTY_MESSAGE")
    if conv.status == "closed":
        raise Conflict("This chat has ended. Start a new chat to keep talking.", code="CHAT_CLOSED")
    if lead_policy(bot).mode == "before" and visitor.contact_id is None and conv.lead_captured_at is None:
        raise Conflict("Please share your details to start the chat.", code="LEAD_REQUIRED")
    m = add_message(db, conv, "visitor", text)
    if conv.status in ("waiting", "open"):
        _notify_new_visitor_message(db, bot, conv, text)
    return m, conv.status == "bot"


def _notify_new_visitor_message(db: Session, bot: ChatBot, conv: ChatConversation, text: str) -> None:
    from app.services.notification_service import notify

    if conv.assignee_id and conv.unread_agent == 1:
        notify(db, conv.assignee_id, type_="chat_message", title=f"New chat message on {bot.name}"[:160],
               body=text[:300], link=f"/apps/{conv.application_id}/chat/inbox?c={conv.id}",
               organization_id=conv.organization_id, application_id=conv.application_id)


def _history(db: Session, conv: ChatConversation) -> list[dict]:
    rows = list(db.scalars(select(ChatMessage).where(ChatMessage.conversation_id == conv.id,
                                                     ChatMessage.role.in_(("visitor", "bot", "agent")))
                           .order_by(ChatMessage.created_at.desc()).limit(60)))[::-1]
    return [{"role": m.role, "body": m.body} for m in rows]


def _context(db: Session, bot: ChatBot, conv: ChatConversation, visitor: ChatVisitor | None) -> dict:
    from app.services.chat import inbox

    now = utcnow()
    tz = inbox.tz_of(bot)
    return {"now": now.astimezone(tz).strftime("%A %d %B %Y, %H:%M ") + str(tz),
            "page_url": (visitor.pages or [{}])[-1].get("url") if visitor and visitor.pages else conv.page_url,
            "page_title": (visitor.pages or [{}])[-1].get("title") if visitor and visitor.pages else conv.page_title,
            "visitor_name": visitor.name if visitor else None,
            "lead_captured": conv.lead_captured_at is not None or bool(visitor and visitor.contact_id),
            "agents_online": agents_available(db, bot)}


def reply_events(db: Session, bot: ChatBot, conv: ChatConversation) -> Iterator[tuple[str, dict]]:
    """Generate the bot's answer to the latest visitor message. Yields ("delta", {"text"}) while it streams, then
    ("message", public message) for the reply and anything it triggered, then ("state", conversation state).
    Commits. Charges the wallet once per AI reply (simulated replies are free)."""
    if conv.status != "bot":
        yield "state", conversation_state(db, bot, conv)
        return
    visitor = db.get(ChatVisitor, conv.visitor_id)
    history = _history(db, conv)
    question = next((m["body"] for m in reversed(history) if m["role"] == "visitor"), "")
    policy = lead_policy(bot)
    lead_known = conv.lead_captured_at is not None or bool(visitor and visitor.contact_id)
    new_msgs: list[ChatMessage] = []

    if ai.configured() and not billing.can_afford(db, bot):
        billing.notify_paused(db, bot)
        avail = agents_available(db, bot)
        meta = {"offer_human": True, "no_ai": True}
        if not lead_known:
            meta["form"] = "lead"
        m = add_message(db, conv, "bot", NO_AI_LINE if avail or not lead_known else
                        "Our assistant can't answer right now. Our team will get back to you soon.",
                        meta=meta, question=question[:2000])
        db.commit()
        yield "message", public_message(m)
        yield "state", conversation_state(db, bot, conv)
        return

    knowledge_text, need_retrieval = knowledge.inline_knowledge(db, bot)
    retrieved = knowledge.retrieve(db, bot, question) if need_retrieval and question else None
    kb = knowledge.simulated_kb(db, bot, question) if not ai.configured() else None
    f = ai.MarkerFilter()
    parts: list[str] = []
    outcome: tuple[str, object] = ("error", "empty")
    for kind, val in ai.stream_reply(snapshot(db, bot), history, knowledge_text, retrieved,
                                     _context(db, bot, conv, visitor), kb):
        if kind == "text":
            out = f.feed(str(val))
            if out:
                parts.append(out)
                yield "delta", {"text": out}
        else:
            outcome = (kind, val)
    tail = f.flush()
    if tail:
        parts.append(tail)
        yield "delta", {"text": tail}
    body = re.sub(r"[ \t]{2,}", " ", "".join(parts)).strip()
    kind, info = outcome
    meta: dict = {}
    charge = False
    markers = f.found
    if kind == "done":
        meta["simulated"] = bool(info.get("simulated"))
        charge = not info.get("simulated")
        if not body:
            body, markers, charge = ai.ERROR_LINE, set(), False
            meta["offer_human"] = True
    elif kind == "refusal":
        body, markers = ai.REFUSAL_LINE, set()
        meta.update(offer_human=True, refusal=True)
    else:
        body, markers = ai.ERROR_LINE, set()
        meta.update(offer_human=True, error=str(info))
    unanswered = ai.UNANSWERED in markers
    if unanswered:
        meta["unanswered"] = True
        if bot.fallback == "collect" and not lead_known:
            meta["form"] = "lead"
        else:
            meta["offer_human"] = True
    if ai.COLLECT in markers and not lead_known:
        meta["form"] = "lead"
    if (policy.mode == "after" and not lead_known and conv.visitor_messages >= policy.after_messages
            and not _asked_for_lead(db, conv)):
        meta["form"] = "lead"
    m = add_message(db, conv, "bot", body, meta=meta, question=question[:2000] or None,
                    flag="unanswered" if unanswered else None)
    new_msgs.append(m)
    if charge:
        conv.ai_replies = (conv.ai_replies or 0) + 1
        billing.charge_reply(db, bot, conv.id, m.id)
    if ai.HANDOFF in markers:
        new_msgs += request_handoff(db, bot, conv, by="bot")
    db.commit()
    agents = _authors(db, new_msgs)
    for nm in new_msgs:
        yield "message", public_message(nm, agents)
    yield "state", conversation_state(db, bot, conv)


def _asked_for_lead(db: Session, conv: ChatConversation) -> bool:
    for meta in db.scalars(select(ChatMessage.meta).where(ChatMessage.conversation_id == conv.id,
                                                          ChatMessage.role == "bot")):
        if (meta or {}).get("form") in ("lead", "lead_required"):
            return True
    return False


# ------------------------------------------------------------------ hand-off


def request_handoff(db: Session, bot: ChatBot, conv: ChatConversation, by: str = "visitor") -> list[ChatMessage]:
    """Ask for a person. With agents online (and inside business hours) the chat joins the waiting queue and is
    routed; otherwise the visitor is offered the offline form (or, if we already have their details, the chat
    becomes an offline message for the team)."""
    from app.services.chat import inbox

    if conv.status in ("waiting", "open"):
        return []
    if conv.status == "closed":
        raise Conflict("This chat has ended. Start a new chat to keep talking.", code="CHAT_CLOSED")
    out: list[ChatMessage] = []
    online = inbox.online_agents(db, bot.application_id) if inbox.hours_open(bot) else []
    if online:
        conv.status = "waiting"
        conv.handoff_requested_at = utcnow()
        out.append(add_message(db, conv, "system", "Connecting you with a team member. Someone will join shortly.",
                               meta={"event": "handoff"}))
        inbox.route(db, bot, conv, online)
        return out
    visitor = db.get(ChatVisitor, conv.visitor_id)
    if conv.lead_captured_at is not None or (visitor and visitor.contact_id and conv.contact_id):
        _make_offline(db, bot, conv, visitor, note="Asked for a person while the team was offline.")
        out.append(add_message(db, conv, "system", "Our team is offline right now. We have your details and will "
                                                   "get back to you as soon as we can.", meta={"event": "offline"}))
        return out
    out.append(add_message(db, conv, "system", "Our team is offline right now. Leave a message and we'll get back "
                                               "to you by email.", meta={"event": "offline", "form": "offline"}))
    return out


def _make_offline(db: Session, bot: ChatBot, conv: ChatConversation, visitor: ChatVisitor | None, note: str) -> None:
    """The chat becomes a message for the team: waiting queue, a follow-up task and notifications."""
    from app.services.chat import inbox

    conv.offline = True
    conv.status = "waiting"
    conv.handoff_requested_at = conv.handoff_requested_at or utcnow()
    contact = db.get(Contact, conv.contact_id) if conv.contact_id else None
    if contact is not None:
        _follow_up_task(db, bot, conv, contact, note)
    inbox.notify_team(db, bot, conv, title=f"New offline chat message on {bot.name}",
                      body=f"{(visitor.name if visitor else None) or 'A visitor'}: {conv.last_message_preview or note}")


def _follow_up_task(db: Session, bot: ChatBot, conv: ChatConversation, contact: Contact, note: str) -> None:
    from app.models import CrmTask
    from app.schemas.crm import TaskCreate
    from app.services.crm import work
    from app.services.crm.common import contact_name, system_ctx
    from app.services.voice.ai_results import next_business_day

    if db.scalar(select(CrmTask.id).where(CrmTask.contact_id == contact.id, CrmTask.status == "open",
                                          CrmTask.title.like("Follow up chat%")).limit(1)):
        return
    from app.services.crm.common import team

    app = db.get(Application, conv.application_id)
    ctx = system_ctx(db, conv.organization_id, conv.application_id)
    assignee = contact.owner_id or conv.assignee_id or bot.created_by_id
    if assignee and assignee not in team(db, conv.organization_id, conv.application_id):
        assignee = None
    notes = f"{note}\nFrom the website chat ({bot.name}).\nConversation: /apps/{conv.application_id}/chat/inbox?c={conv.id}"
    work.create_task(db, ctx, TaskCreate(title=f"Follow up chat: {contact_name(contact)}"[:200], type="follow_up",
                                         priority="high", due_at=next_business_day(contact.timezone or (
                                             app.timezone if app else None)), notes=notes[:5000],
                                         contact_id=contact.id, assignee_id=assignee))


# ------------------------------------------------------------------ lead capture → Contacts and the CRM


def _field_values(policy: LeadCapture, values: dict, partial: bool = False) -> dict:
    out = {}
    for f in policy.fields:
        v = (values.get(f.key) or "").strip()
        if f.required and not v and not partial:
            raise ValidationFailed(f"{f.label} is required", code="LEAD_FIELD_REQUIRED", details={"field": f.key})
        if v:
            out[f.key] = v
    if "email" in out and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", out["email"]):
        raise ValidationFailed("Enter a valid email address", code="INVALID_EMAIL", details={"field": "email"})
    return out


def upsert_contact(db: Session, bot: ChatBot, conv: ChatConversation, visitor: ChatVisitor, values: dict,
                   consent: bool, ip: str | None, host: str | None) -> Contact | None:
    """Find or create the contact for these details, record consent with its evidence, and run the CRM
    (lifecycle, owner assignment, scoring, `chat_lead_captured` event). None if the plan's contact limit is full."""
    from app.services.audience import consent as consent_svc
    from app.services.audience import contacts as csvc
    from app.services.audience.normalize import check_identity, identity_keys, normalize_contact
    from app.services.billing import plans
    from app.services.crm import leads as crm_leads
    from app.services.crm.common import record_event, settings_for, system_activity, system_ctx
    from app.utils.contact_normalize import InvalidValue

    ctx = system_ctx(db, bot.organization_id, bot.application_id)
    raw: dict = {"attributes": {}}
    if values.get("name"):
        raw["full_name"] = values["name"]
    for k in ("email", "phone", "company"):
        if values.get(k):
            raw[k] = values[k]
    for k, v in values.items():
        if k.startswith("attr:"):
            raw["attributes"][k[5:]] = v
    try:
        n = normalize_contact(raw, default_country=ctx.application.default_country if ctx.application else None,
                              attr_defs=csvc.attr_defs(db, ctx), strict_attributes=False)
        rule = csvc.identity_rule(db, ctx)
        check_identity(rule, n.email, n.phone.e164 if n.phone else None)
    except InvalidValue as exc:
        raise ValidationFailed(str(exc), code="INVALID_CONTACT") from exc
    email_key, phone_key = identity_keys(rule, n.email, n.phone.e164 if n.phone else None)
    c = csvc._find_conflict(db, ctx, email_key, phone_key)
    created = c is None
    source = f"Chat: {bot.name}"[:60]
    if c is None:
        try:
            plans.check_limit(db, bot.organization_id, "contacts", plans.count_usage(db, bot.organization_id, "contacts"))
        except ValidationFailed:
            log.warning("chat_lead_contact_limit", bot_id=bot.id)
            return None
        c = Contact(organization_id=bot.organization_id, application_id=bot.application_id, created_by_id=None,
                    source=source, attributes={})
        csvc.apply_normalized(c, n, rule, only_provided=False)
        c.source = source
        db.add(c)
        db.flush()
        consent_svc.record_activity(db, ctx, c.id, "created", "Contact created from the website chat",
                                    {"source": source, "conversation_id": conv.id})
    else:
        csvc.apply_normalized(c, n, rule, only_provided=True, keep_existing=True)
    policy = lead_policy(bot)
    page = (visitor.pages or [{}])[-1].get("url") if visitor.pages else conv.page_url
    if consent and policy.consent.enabled:
        evidence = (f"Ticked “{policy.consent.text}” in the {bot.name} website chat"
                    f"{' on ' + page if page else (' on ' + host if host else '')} at "
                    f"{utcnow().strftime('%Y-%m-%d %H:%M UTC')} (conversation {conv.id}).")
        for ch in policy.consent.channels:
            try:
                consent_svc.grant(db, ctx, c, ch, method="chat", source=source, evidence=evidence, ip=ip,
                                  consent_reference=conv.id)
            except ValidationFailed:
                log.warning("chat_consent_not_recorded", channel=ch)
    if c.lifecycle_stage == "subscriber":
        c.lifecycle_stage = "lead"
    c.last_activity_at = utcnow()
    first_capture = conv.lead_captured_at is None
    conv.contact_id = c.id
    visitor.contact_id = c.id
    visitor.name = visitor.name or (" ".join(x for x in (c.first_name, c.last_name) if x) or None)
    visitor.email = visitor.email or c.email
    visitor.phone = visitor.phone or c.phone
    if first_capture:
        conv.lead_captured_at = utcnow()
        system_activity(db, bot.organization_id, bot.application_id, f"Lead captured by chatbot “{bot.name}”",
                        contact_id=c.id, meta={"conversation_id": conv.id, "bot_id": bot.id, "page": page})
        record_event(db, bot.organization_id, bot.application_id, "chat_lead_captured", contact_id=c.id,
                     data={"bot_id": bot.id, "conversation_id": conv.id, "bot": bot.name, "new_contact": created})
    db.flush()
    crm_leads.assign_contact_now(db, c)
    s = settings_for(db, bot.organization_id, bot.application_id)
    rules = list(db.scalars(select(ScoringRule).where(ScoringRule.application_id == bot.application_id)))
    if rules:
        crm_leads.score_contacts(db, s, [c], rules)
    return c


def submit_lead(db: Session, bot: ChatBot, conv: ChatConversation, visitor: ChatVisitor, values: dict,
                consent: bool, ip: str | None, host: str | None) -> list[ChatMessage]:
    if conv.status == "closed":
        raise Conflict("This chat has ended.", code="CHAT_CLOSED")
    clean = _field_values(lead_policy(bot), values)
    if not (clean.get("email") or clean.get("phone")):
        raise ValidationFailed("Enter your email or phone number", code="LEAD_FIELD_REQUIRED")
    identify(visitor, {"name": clean.get("name"), "email": clean.get("email"), "phone": clean.get("phone")})
    upsert_contact(db, bot, conv, visitor, clean, consent, ip, host)
    conv.lead_captured_at = conv.lead_captured_at or utcnow()
    first = (clean.get("name") or "").split(" ")[0]
    out = [add_message(db, conv, "bot", f"Thanks{', ' + first if first else ''}! We've got your details."
                       + (" How else can I help?" if conv.status == "bot" else ""), meta={"event": "lead"})]
    if conv.offline or (conv.status == "waiting" and not agents_available(db, bot)):
        contact = db.get(Contact, conv.contact_id) if conv.contact_id else None
        if contact is not None:
            _follow_up_task(db, bot, conv, contact, "Asked for a person while the team was offline.")
    return out


def submit_offline(db: Session, bot: ChatBot, visitor: ChatVisitor, conv: ChatConversation | None, data,
                   ip: str | None) -> ChatConversation:
    """The offline form: a message for the team (waiting queue), a contact, a follow-up task and notifications."""
    if conv is None or conv.status == "closed":
        conv = ChatConversation(organization_id=bot.organization_id, application_id=bot.application_id,
                                bot_id=bot.id, visitor_id=visitor.id, status="bot", tags=[],
                                page_url=(visitor.pages or [{}])[-1].get("url") if visitor.pages else None)
        db.add(conv)
        db.flush()
    values = {"email": data.email.strip()}
    if data.name:
        values["name"] = data.name.strip()
    if data.phone:
        values["phone"] = data.phone.strip()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", values["email"]):
        raise ValidationFailed("Enter a valid email address", code="INVALID_EMAIL", details={"field": "email"})
    identify(visitor, values)
    add_message(db, conv, "visitor", data.message.strip(), meta={"offline": True})
    upsert_contact(db, bot, conv, visitor, values, data.consent, ip, data.host)
    conv.lead_captured_at = conv.lead_captured_at or utcnow()
    _make_offline(db, bot, conv, visitor, note=f"Offline message: {data.message.strip()[:500]}")
    add_message(db, conv, "system", f"Thanks! We've got your message and will reply to {values['email']} as soon "
                                    "as we can.", meta={"event": "offline_received"})
    return conv


# ------------------------------------------------------------------ closing, summary, rating, transcript


def close(db: Session, conv: ChatConversation, by: str, actor_name: str | None = None) -> ChatMessage | None:
    if conv.status == "closed":
        return None
    conv.status = "closed"
    conv.closed_at = utcnow()
    conv.closed_by = by
    conv.unread_agent = 0
    text = "The visitor ended the chat." if by == "visitor" else \
        f"{actor_name or 'The team'} ended the chat." if by == "agent" else "This chat was closed."
    return add_message(db, conv, "system", text, meta={"event": "closed"})


def process_closed(db: Session, conv: ChatConversation) -> bool:
    """AI summary (intent, sentiment, lead quality, follow-up) → the conversation, the contact's timeline and the
    `chat_conversation_closed` event. Once per conversation."""
    from app.services.crm.common import record_event

    if conv.ai_processed_at is not None or conv.status != "closed":
        return False
    rows = list(db.scalars(select(ChatMessage).where(ChatMessage.conversation_id == conv.id,
                                                     ChatMessage.role.in_(("visitor", "bot", "agent")))
                           .order_by(ChatMessage.created_at)))
    bot = db.get(ChatBot, conv.bot_id)
    conv.ai_processed_at = utcnow()
    if not any(m.role == "visitor" for m in rows):
        return True
    msgs = [{"role": m.role, "body": m.body} for m in rows]
    facts = {"lead_captured": conv.lead_captured_at is not None, "handoff": conv.handoff_requested_at is not None,
             "offline": conv.offline, "rating": conv.rating}
    out = ai.summarise(msgs, facts, business_name(db, bot))
    conv.ai_summary = (out.get("summary") or "Summary unavailable")[:4000]
    conv.ai_intent = (out.get("intent") or None) and out["intent"][:200]
    conv.ai_sentiment, conv.ai_lead_quality = out.get("sentiment"), out.get("lead_quality")
    conv.ai_follow_up = (out.get("follow_up") or None) and out["follow_up"][:500]
    if conv.contact_id:
        contact = db.get(Contact, conv.contact_id)
        if contact is not None and contact.application_id == conv.application_id:
            human = conv.agent_joined_at is not None
            mins = max(1, round(((conv.closed_at or utcnow()) - conv.created_at).total_seconds() / 60))
            db.add(CrmActivity(
                organization_id=conv.organization_id, application_id=conv.application_id, type="chat",
                subject=f"Chat conversation: {bot.name}"[:200], body=conv.ai_summary,
                outcome=conv.ai_lead_quality, duration_minutes=mins, occurred_at=conv.closed_at or utcnow(),
                actor_user_id=conv.assignee_id if human else None, contact_id=contact.id,
                company_id=contact.company_id,
                meta={"conversation_id": conv.id, "bot_id": bot.id, "bot": bot.name, "intent": conv.ai_intent,
                      "sentiment": conv.ai_sentiment, "lead_quality": conv.ai_lead_quality,
                      "follow_up": conv.ai_follow_up, "messages": len(rows), "handed_off": human,
                      "rating": conv.rating, "simulated": bool(out.get("simulated"))}))
            contact.last_activity_at = max(contact.last_activity_at or conv.closed_at, conv.closed_at or utcnow())
            if conv.ai_lead_quality == "hot" and not human and not conv.offline:
                _follow_up_task(db, bot, conv, contact, f"Hot lead from the website chat. {conv.ai_follow_up or ''}")
    record_event(db, conv.organization_id, conv.application_id, "chat_conversation_closed",
                 contact_id=conv.contact_id,
                 data={"bot_id": conv.bot_id, "conversation_id": conv.id, "lead_quality": conv.ai_lead_quality,
                       "sentiment": conv.ai_sentiment, "rating": conv.rating})
    return True


def process_closed_job(conversation_id: str) -> str:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        conv = db.get(ChatConversation, conversation_id)
        if conv is None:
            return "missing"
        try:
            done = process_closed(db, conv)
            db.commit()
            return "processed" if done else "skipped"
        except Exception:
            db.rollback()
            log.exception("chat_summary_failed", conversation_id=conversation_id)
            return "error"


def rate(db: Session, conv: ChatConversation, rating: str, comment: str | None) -> None:
    if conv.visitor_messages == 0:
        raise ValidationFailed("There's nothing to rate yet", code="NOTHING_TO_RATE")
    conv.rating = rating
    conv.rating_comment = (comment or "").strip()[:1000] or None
    conv.rated_at = utcnow()
    conv.updated_at = utcnow()
    db.add(ChatMessage(organization_id=conv.organization_id, application_id=conv.application_id,
                       conversation_id=conv.id, role="note", body=f"Visitor rated the chat "
                       f"{'👍 good' if rating == 'up' else '👎 bad'}" + (f": “{conv.rating_comment}”"
                                                                       if conv.rating_comment else ""),
                       meta={"event": "rating"}, created_at=utcnow()))


def transcript_email(db: Session, bot: ChatBot, conv: ChatConversation, to_email: str) -> bool:
    from app.services.mail_templates import RenderedEmail
    from app.services.notifications import enqueue_system_email

    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", to_email.strip()):
        raise ValidationFailed("Enter a valid email address", code="INVALID_EMAIL")
    msgs = [m for m in visible_messages(db, conv, limit=500) if m["role"] in ("visitor", "bot", "agent")]
    business = business_name(db, bot)
    who = {"visitor": "You", "bot": bot.name, "agent": None}
    rows_html, rows_text = [], []
    for m in msgs:
        name = who[m["role"]] or m.get("author") or business
        when = m["created_at"][:16].replace("T", " ")
        rows_html.append(f'<tr><td style="padding:8px 0;border-bottom:1px solid #eef0f3"><div style="font-size:12px;'
                         f'color:#64748b">{escape(name)} · {escape(when)} UTC</div><div style="white-space:pre-wrap">'
                         f'{escape(m["body"])}</div></td></tr>')
        rows_text.append(f"{name} ({when} UTC):\n{m['body']}\n")
    subject = f"Your chat with {business}"
    html = (f'<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Arial,sans-serif;color:#0f172a">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" '
            f'style="padding:32px 16px"><table role="presentation" width="560" cellpadding="0" cellspacing="0" '
            f'style="background:#fff;border-radius:12px;border:1px solid #e5e7eb"><tr><td style="padding:28px 32px">'
            f'<h1 style="font-size:18px;margin:0 0 16px">{escape(subject)}</h1><table role="presentation" '
            f'width="100%">{"".join(rows_html)}</table><p style="font-size:12px;color:#64748b;margin-top:20px">You '
            f'asked for this transcript in the chat on {escape(business)}\'s website.</p></td></tr></table></td></tr>'
            f'</table></body></html>')
    text = f"{subject}\n\n" + "\n".join(rows_text)
    return enqueue_system_email("chat_transcript", to_email.strip(), None, RenderedEmail(subject, html, text),
                                idempotency_key=f"chat-transcript:{conv.id}:{to_email.strip().lower()}:"
                                                f"{conv.message_count}")


BOT_IDLE = timedelta(minutes=30)
HUMAN_IDLE = timedelta(hours=24)


def tick(db: Session, limit: int = 200) -> dict:
    """Close chats nobody is using any more (bot chats idle for 30 minutes, team chats idle for a day) and
    summarise closed chats whose summary is missing (worker restarts)."""
    now = utcnow()
    idle = list(db.scalars(select(ChatConversation).where(
        ((ChatConversation.status == "bot") & (ChatConversation.last_message_at < now - BOT_IDLE)) |
        ((ChatConversation.status.in_(("waiting", "open"))) & (ChatConversation.last_message_at < now - HUMAN_IDLE)))
        .limit(limit)))
    for c in idle:
        close(db, c, "system")
    db.commit()
    pending = list(db.scalars(select(ChatConversation.id).where(
        ChatConversation.status == "closed", ChatConversation.ai_processed_at.is_(None)).limit(50)))
    done = sum(1 for cid in pending if process_closed_job(cid) == "processed")
    return {"closed": len(idle), "summarised": done}


def tick_job() -> dict:
    from app.core.database import SessionLocal

    with SessionLocal() as db:
        return tick(db)


def stats_for_visitor(db: Session, visitor_id: str) -> int:
    return db.scalar(select(func.count()).select_from(ChatConversation).where(
        ChatConversation.visitor_id == visitor_id)) or 0

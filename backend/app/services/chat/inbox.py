"""The live-chat inbox for the team: agents (seats and presence), business hours, routing of hand-offs, the
conversation list / transcript / visitor panel, agent actions and canned responses.

Seats: a member becomes a chat agent of an application when they first go online in the inbox (or a manager
adds them). Each distinct agent across the organization takes one `chat_seats` seat (Starter 2, Pro 25).
Presence: the inbox sends a heartbeat every ~20 seconds; an agent counts as online for ONLINE_WINDOW after it.
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.errors import Forbidden, NotFound, ValidationFailed
from app.core.permissions import ORG_WIDE_ROLES, Perm, Role, permissions_for
from app.models import ApplicationMember, Contact, Deal, OrganizationMember, User
from app.models.chat import ChatAgent, ChatBot, ChatCannedResponse, ChatConversation, ChatMessage, ChatVisitor
from app.schemas.chat import BusinessHours, CannedIn
from app.schemas.common import Page, PageParams
from app.services.billing import plans
from app.services.chat import conversations as convs
from app.services.notification_service import notify
from app.services.tenancy import effective_app_role
from app.utils.time import utcnow

ONLINE_WINDOW = timedelta(seconds=75)
FILTERS = ("open", "mine", "unassigned", "bot", "closed", "all")
DAY_KEYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


# ------------------------------------------------------------------ hours


def tz_of(bot: ChatBot) -> ZoneInfo:
    try:
        return ZoneInfo((bot.business_hours or {}).get("timezone") or "UTC")
    except Exception:  # noqa: BLE001 - unknown zone names
        return ZoneInfo("UTC")


def hours_open(bot: ChatBot, at: datetime | None = None) -> bool:
    h = BusinessHours.model_validate(bot.business_hours or {})
    if not h.enabled:
        return True
    local = (at or utcnow()).astimezone(tz_of(bot))
    span = h.days.get(DAY_KEYS[local.weekday()])
    return bool(span) and span[0] <= local.strftime("%H:%M") < span[1]


# ------------------------------------------------------------------ agents and seats


def _seat_users(db: Session, organization_id: str) -> set[str]:
    return set(db.scalars(select(ChatAgent.user_id).where(ChatAgent.organization_id == organization_id)))


def _count_seats(db: Session, organization_id: str) -> int:
    return len(_seat_users(db, organization_id))


plans.register_usage_counter("chat_seats", _count_seats)


def can_reply(db: Session, organization_id: str, application_id: str, user_id: str) -> bool:
    om = db.scalar(select(OrganizationMember).where(OrganizationMember.organization_id == organization_id,
                                                    OrganizationMember.user_id == user_id))
    if om is None:
        return False
    role = Role(om.role_key)
    am = None if role in ORG_WIDE_ROLES else db.scalar(select(ApplicationMember).where(
        ApplicationMember.application_id == application_id, ApplicationMember.user_id == user_id))
    eff = effective_app_role(role, am)
    return eff is not None and Perm.CHAT_REPLY in permissions_for(eff)


def add_agent(db: Session, organization_id: str, application_id: str, user_id: str) -> ChatAgent:
    a = db.scalar(select(ChatAgent).where(ChatAgent.application_id == application_id, ChatAgent.user_id == user_id))
    if a is not None:
        return a
    if not can_reply(db, organization_id, application_id, user_id):
        raise ValidationFailed("That person can't answer chats in this application (their role needs the "
                               "live-chat permission).", code="NOT_A_CHAT_AGENT")
    if user_id not in _seat_users(db, organization_id):
        plans.check_limit(db, organization_id, "chat_seats", _count_seats(db, organization_id))
    a = ChatAgent(organization_id=organization_id, application_id=application_id, user_id=user_id, status="offline")
    db.add(a)
    db.flush()
    return a


def try_add_agent(db: Session, organization_id: str, application_id: str, user_id: str) -> ChatAgent | None:
    try:
        return add_agent(db, organization_id, application_id, user_id)
    except ValidationFailed:
        return None


def require_agent(db: Session, ctx) -> ChatAgent:
    """The signed-in user as an agent of this application (takes a seat the first time)."""
    ctx.require(Perm.CHAT_REPLY)
    if ctx.support:
        raise Forbidden("Support sessions are read-only", code="READ_ONLY")
    return add_agent(db, ctx.organization_id, ctx.application_id, ctx.user.id)


def heartbeat(db: Session, ctx, status: str) -> dict:
    a = require_agent(db, ctx)
    a.status = status
    a.last_seen_at = utcnow()
    db.flush()
    return {"status": a.status, "online_agents": len(online_agents(db, ctx.application_id))}


def online_agents(db: Session, application_id: str) -> list[ChatAgent]:
    return list(db.scalars(select(ChatAgent).where(ChatAgent.application_id == application_id,
                                                   ChatAgent.status == "online",
                                                   ChatAgent.last_seen_at >= utcnow() - ONLINE_WINDOW)
                           .order_by(ChatAgent.created_at)))


def agents_out(db: Session, ctx) -> dict:
    ctx.require(Perm.CHAT_READ)
    rows = list(db.scalars(select(ChatAgent).where(ChatAgent.application_id == ctx.application_id)
                           .order_by(ChatAgent.created_at)))
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_([a.user_id for a in rows])))} if rows else {}
    cutoff = utcnow() - ONLINE_WINDOW
    members = db.execute(select(User).join(OrganizationMember, OrganizationMember.user_id == User.id).where(
        OrganizationMember.organization_id == ctx.organization_id)).scalars().all()
    candidates = [{"id": u.id, "full_name": u.full_name, "email": u.email} for u in members
                  if u.id not in users and can_reply(db, ctx.organization_id, ctx.application_id, u.id)]
    return {"agents": [{"user_id": a.user_id, "full_name": users[a.user_id].full_name if a.user_id in users else None,
                        "email": users[a.user_id].email if a.user_id in users else None,
                        "status": a.status if a.last_seen_at and a.last_seen_at >= cutoff else "offline",
                        "last_seen_at": a.last_seen_at.isoformat() if a.last_seen_at else None} for a in rows],
            "candidates": candidates,
            "seats": {"used": _count_seats(db, ctx.organization_id),
                      "limit": plans.limit(db, ctx.organization_id, "chat_seats")},
            "me": next(({"status": a.status if a.last_seen_at and a.last_seen_at >= cutoff else "offline"}
                        for a in rows if ctx.user and a.user_id == ctx.user.id), None),
            "can_reply": ctx.has(Perm.CHAT_REPLY)}


def manage_add(db: Session, ctx, user_id: str) -> None:
    ctx.require(Perm.CHAT_WRITE)
    add_agent(db, ctx.organization_id, ctx.application_id, user_id)


def manage_remove(db: Session, ctx, user_id: str) -> None:
    ctx.require(Perm.CHAT_WRITE)
    a = db.scalar(select(ChatAgent).where(ChatAgent.application_id == ctx.application_id, ChatAgent.user_id == user_id))
    if a is None:
        raise NotFound("Agent not found")
    db.delete(a)


# ------------------------------------------------------------------ routing and notifications


def route(db: Session, bot: ChatBot, conv: ChatConversation, online: list[ChatAgent]) -> None:
    """Round robin: assign the next online agent. Broadcast: leave it unassigned and alert every online agent."""
    link = f"/apps/{conv.application_id}/chat/inbox?c={conv.id}"
    visitor = db.get(ChatVisitor, conv.visitor_id)
    who = (visitor.name if visitor else None) or "A visitor"
    if bot.routing == "round_robin" and online:
        pick = online[(bot.routing_cursor or 0) % len(online)]
        bot.routing_cursor = (bot.routing_cursor or 0) + 1
        conv.assignee_id = pick.user_id
        notify(db, pick.user_id, type_="chat_handoff", level="warning", title=f"{who} wants to talk to you"[:160],
               body=conv.last_message_preview, link=link, organization_id=conv.organization_id,
               application_id=conv.application_id)
        return
    for a in online:
        notify(db, a.user_id, type_="chat_handoff", level="warning", title=f"{who} is waiting for a person"[:160],
               body=f"{bot.name}: {conv.last_message_preview or ''}"[:500], link=link,
               organization_id=conv.organization_id, application_id=conv.application_id)


def notify_team(db: Session, bot: ChatBot, conv: ChatConversation, title: str, body: str) -> None:
    """Offline messages: every agent of the application, or the owners and admins when there are none."""
    users = set(db.scalars(select(ChatAgent.user_id).where(ChatAgent.application_id == conv.application_id)))
    if not users:
        users = set(db.scalars(select(OrganizationMember.user_id).where(
            OrganizationMember.organization_id == conv.organization_id,
            OrganizationMember.role_key.in_(("owner", "admin")))))
    for uid in users:
        notify(db, uid, type_="chat_offline_message", level="warning", title=title[:160], body=body[:500],
               link=f"/apps/{conv.application_id}/chat/inbox?c={conv.id}", organization_id=conv.organization_id,
               application_id=conv.application_id)


# ------------------------------------------------------------------ listing


def _conv_row(db: Session, ctx, conv_id: str) -> ChatConversation:
    c = db.get(ChatConversation, conv_id)
    if c is None or c.application_id != ctx.application_id:
        raise NotFound("Conversation not found")
    return c


def _filter(q, ctx, f: str):
    if f == "open":
        return q.where(ChatConversation.status.in_(("waiting", "open")))
    if f == "mine":
        return q.where(ChatConversation.assignee_id == ctx.user.id, ChatConversation.status != "closed")
    if f == "unassigned":
        return q.where(ChatConversation.assignee_id.is_(None), ChatConversation.status == "waiting")
    if f == "bot":
        return q.where(ChatConversation.status == "bot")
    if f == "closed":
        return q.where(ChatConversation.status == "closed")
    return q


def counts(db: Session, ctx) -> dict[str, int]:
    base = select(func.count()).select_from(ChatConversation).where(ChatConversation.application_id == ctx.application_id)
    return {f: db.scalar(_filter(base, ctx, f)) or 0 for f in ("open", "mine", "unassigned", "bot")}


def _list_item(c: ChatConversation, visitor: ChatVisitor | None, contact: Contact | None, users: dict,
               bots: dict) -> dict:
    name = (contact.full_name if contact else None) or (visitor.name if visitor else None) or \
        (contact.email if contact else None) or (visitor.email if visitor else None) or \
        f"Visitor {c.visitor_id[:4].upper()}"
    assignee = users.get(c.assignee_id)
    return {"id": c.id, "status": c.status, "name": name, "email": (contact.email if contact else None) or
            (visitor.email if visitor else None), "bot": {"id": c.bot_id, "name": bots.get(c.bot_id)},
            "assignee": {"id": assignee.id, "full_name": assignee.full_name} if assignee else None,
            "preview": c.last_message_preview, "last_message_at": c.last_message_at.isoformat()
            if c.last_message_at else None, "unread": c.unread_agent or 0, "tags": c.tags or [],
            "offline": c.offline, "lead": c.lead_captured_at is not None, "rating": c.rating,
            "waiting_since": c.handoff_requested_at.isoformat() if c.handoff_requested_at and c.status == "waiting"
            else None, "contact_id": c.contact_id, "lead_quality": c.ai_lead_quality,
            "updated_at": c.updated_at.isoformat()}


def _items(db: Session, rows: list[ChatConversation]) -> list[dict]:
    vis = {v.id: v for v in db.scalars(select(ChatVisitor).where(ChatVisitor.id.in_({r.visitor_id for r in rows})))} \
        if rows else {}
    cids = {r.contact_id for r in rows if r.contact_id}
    cons = {c.id: c for c in db.scalars(select(Contact).where(Contact.id.in_(cids)))} if cids else {}
    uids = {r.assignee_id for r in rows if r.assignee_id}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(uids)))} if uids else {}
    bots = dict(db.execute(select(ChatBot.id, ChatBot.name).where(ChatBot.id.in_({r.bot_id for r in rows}))).all()) \
        if rows else {}
    return [_list_item(r, vis.get(r.visitor_id), cons.get(r.contact_id), users, bots) for r in rows]


def list_conversations(db: Session, ctx, params: PageParams, f: str = "open", q: str | None = None,
                       bot_id: str | None = None) -> dict:
    ctx.require(Perm.CHAT_READ)
    if f not in FILTERS:
        raise ValidationFailed("Unknown filter")
    stmt = _filter(select(ChatConversation).where(ChatConversation.application_id == ctx.application_id), ctx, f)
    if bot_id:
        stmt = stmt.where(ChatConversation.bot_id == bot_id)
    if q and q.strip():
        term = f"%{q.strip()[:100]}%"
        vids = select(ChatVisitor.id).where(ChatVisitor.application_id == ctx.application_id,
                                            or_(ChatVisitor.name.ilike(term), ChatVisitor.email.ilike(term),
                                                ChatVisitor.phone.ilike(term)))
        mids = select(ChatMessage.conversation_id).where(ChatMessage.application_id == ctx.application_id,
                                                         ChatMessage.body.ilike(term))
        stmt = stmt.where(or_(ChatConversation.visitor_id.in_(vids), ChatConversation.id.in_(mids),
                              ChatConversation.last_message_preview.ilike(term)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    order = [ChatConversation.handoff_requested_at.desc()] if f == "unassigned" else []
    rows = list(db.scalars(stmt.order_by(*order, ChatConversation.last_message_at.desc(), ChatConversation.id)
                           .offset(params.offset).limit(params.page_size)))
    page = Page(items=_items(db, rows), total=total, page=params.page, page_size=params.page_size)
    return {**page.model_dump(), "counts": counts(db, ctx)}


def updates(db: Session, ctx, since: datetime | None) -> dict:
    """For polling: conversations changed since `since`, the filter counts and new hand-off requests."""
    ctx.require(Perm.CHAT_READ)
    now = utcnow()
    since = since or now - timedelta(seconds=10)
    rows = list(db.scalars(select(ChatConversation).where(ChatConversation.application_id == ctx.application_id,
                                                          ChatConversation.updated_at > since)
                           .order_by(ChatConversation.updated_at.desc()).limit(100)))
    alerts = [i for i in _items(db, [r for r in rows if r.status == "waiting" and r.handoff_requested_at
                                     and r.handoff_requested_at > since])]
    new_chats = [i for i in _items(db, [r for r in rows if r.created_at > since and r.status == "bot"])]
    return {"now": now.isoformat(), "changed": _items(db, rows), "counts": counts(db, ctx), "handoffs": alerts,
            "new_chats": new_chats}


# ------------------------------------------------------------------ one conversation


def message_out(m: ChatMessage, users: dict) -> dict:
    u = users.get(m.author_id) if m.author_id else None
    return {"id": m.id, "role": m.role, "body": m.body, "created_at": m.created_at.isoformat(),
            "author": {"id": u.id, "full_name": u.full_name} if u else None, "question": m.question,
            "flag": m.flag, "meta": m.meta or {}}


def messages(db: Session, ctx, conv_id: str, after: datetime | None = None) -> list[dict]:
    ctx.require(Perm.CHAT_READ)
    c = _conv_row(db, ctx, conv_id)
    q = select(ChatMessage).where(ChatMessage.conversation_id == c.id)
    if after is not None:
        q = q.where(ChatMessage.created_at > after)
    rows = list(db.scalars(q.order_by(ChatMessage.created_at).limit(1000)))
    uids = {m.author_id for m in rows if m.author_id}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(uids)))} if uids else {}
    return [message_out(m, users) for m in rows]


def detail(db: Session, ctx, conv_id: str) -> dict:
    ctx.require(Perm.CHAT_READ)
    c = _conv_row(db, ctx, conv_id)
    visitor = db.get(ChatVisitor, c.visitor_id)
    contact = db.get(Contact, c.contact_id) if c.contact_id else None
    bot = db.get(ChatBot, c.bot_id)
    item = _items(db, [c])[0]
    owner = db.get(User, contact.owner_id) if contact and contact.owner_id else None
    deals = [{"id": d.id, "name": d.title, "status": d.status, "amount": float(d.amount or 0),
              "currency": d.currency} for d in db.scalars(
        select(Deal).where(Deal.contact_id == contact.id).order_by(Deal.created_at.desc()).limit(5))] if contact else []
    prev_q = select(ChatConversation).where(ChatConversation.application_id == ctx.application_id,
                                            ChatConversation.id != c.id)
    prev_q = prev_q.where(or_(ChatConversation.visitor_id == c.visitor_id, ChatConversation.contact_id == c.contact_id)
                          if c.contact_id else ChatConversation.visitor_id == c.visitor_id)
    previous = [{"id": p.id, "status": p.status, "created_at": p.created_at.isoformat(),
                 "preview": p.last_message_preview, "summary": p.ai_summary}
                for p in db.scalars(prev_q.order_by(ChatConversation.created_at.desc()).limit(10))]
    return {**item, "messages": messages(db, ctx, c.id),
            "conversation": {"created_at": c.created_at.isoformat(), "page_url": c.page_url, "page_title": c.page_title,
                             "handoff_requested_at": c.handoff_requested_at.isoformat() if c.handoff_requested_at
                             else None, "agent_joined_at": c.agent_joined_at.isoformat() if c.agent_joined_at else None,
                             "closed_at": c.closed_at.isoformat() if c.closed_at else None, "closed_by": c.closed_by,
                             "rating": c.rating, "rating_comment": c.rating_comment,
                             "summary": {"text": c.ai_summary, "intent": c.ai_intent, "sentiment": c.ai_sentiment,
                                         "lead_quality": c.ai_lead_quality, "follow_up": c.ai_follow_up}
                             if c.ai_summary else None},
            "visitor": {"id": visitor.id, "name": visitor.name, "email": visitor.email, "phone": visitor.phone,
                        "pages": list(reversed(visitor.pages or []))[:15], "current_page": (visitor.pages or [{}])[-1]
                        if visitor.pages else None, "referrer": visitor.referrer, "utm": visitor.utm or {},
                        "attributes": visitor.attributes or {}, "country": visitor.country,
                        "user_agent": visitor.user_agent, "first_seen_at": visitor.first_seen_at.isoformat(),
                        "last_seen_at": visitor.last_seen_at.isoformat()} if visitor else None,
            "contact": {"id": contact.id, "name": contact.full_name, "email": contact.email, "phone": contact.phone,
                        "company": contact.company, "lifecycle_stage": contact.lifecycle_stage,
                        "lead_score": contact.lead_score, "owner": {"id": owner.id, "full_name": owner.full_name}
                        if owner else None, "deals": deals} if contact else None,
            "previous": previous, "bot_status": bot.status if bot else None,
            "can_reply": ctx.has(Perm.CHAT_REPLY)}


# ------------------------------------------------------------------ agent actions


def _agent_name(ctx) -> str:
    return ((ctx.user.full_name or "").split(" ")[0] or "A team member") if ctx.user else "A team member"


def join(db: Session, ctx, conv_id: str) -> ChatConversation:
    require_agent(db, ctx)
    c = _conv_row(db, ctx, conv_id)
    if c.status == "closed":
        raise ValidationFailed("This chat is closed. Reopen it first.", code="CHAT_CLOSED")
    if c.status == "open" and c.assignee_id == ctx.user.id:
        return c
    c.status = "open"
    c.assignee_id = ctx.user.id
    c.agent_joined_at = c.agent_joined_at or utcnow()
    c.handoff_requested_at = c.handoff_requested_at or utcnow()
    convs.add_message(db, c, "system", f"{_agent_name(ctx)} joined the chat.", author_id=ctx.user.id,
                      meta={"event": "joined"})
    return c


def reply(db: Session, ctx, conv_id: str, body: str, internal: bool) -> ChatMessage:
    require_agent(db, ctx)
    c = _conv_row(db, ctx, conv_id)
    if internal:
        return convs.add_message(db, c, "note", body.strip(), author_id=ctx.user.id)
    if c.status == "closed":
        raise ValidationFailed("This chat is closed. Reopen it to reply.", code="CHAT_CLOSED")
    if c.status != "open" or c.assignee_id != ctx.user.id:
        join(db, ctx, conv_id)
    m = convs.add_message(db, c, "agent", body.strip(), author_id=ctx.user.id)
    now = utcnow()
    if c.first_human_response_at is None:
        c.first_human_response_at = now
    c.unread_agent = 0
    if c.contact_id:
        from app.services.crm.common import touched

        contact = db.get(Contact, c.contact_id)
        if contact is not None:
            touched(db, contact=contact, at=now)
    return m


def assign(db: Session, ctx, conv_id: str, user_id: str | None) -> ChatConversation:
    ctx.require(Perm.CHAT_REPLY)
    c = _conv_row(db, ctx, conv_id)
    if user_id:
        add_agent(db, ctx.organization_id, ctx.application_id, user_id)
        u = db.get(User, user_id)
        c.assignee_id = user_id
        if c.status == "bot":
            c.status = "waiting"
            c.handoff_requested_at = c.handoff_requested_at or utcnow()
        convs.add_message(db, c, "note", f"Assigned to {u.full_name if u else 'a teammate'} by {_agent_name(ctx)}.",
                          author_id=ctx.user.id, meta={"event": "assigned"})
        if user_id != ctx.user.id:
            notify(db, user_id, type_="chat_assigned", title=f"{_agent_name(ctx)} assigned you a chat"[:160],
                   body=c.last_message_preview, link=f"/apps/{c.application_id}/chat/inbox?c={c.id}",
                   organization_id=c.organization_id, application_id=c.application_id)
    else:
        c.assignee_id = None
        if c.status == "open":
            c.status = "waiting"
    c.updated_at = utcnow()
    return c


def set_tags(db: Session, ctx, conv_id: str, tags: list[str]) -> ChatConversation:
    ctx.require(Perm.CHAT_REPLY)
    c = _conv_row(db, ctx, conv_id)
    c.tags = tags
    c.updated_at = utcnow()
    return c


def close(db: Session, ctx, conv_id: str) -> ChatConversation:
    ctx.require(Perm.CHAT_REPLY)
    c = _conv_row(db, ctx, conv_id)
    convs.close(db, c, "agent", _agent_name(ctx))
    return c


def reopen(db: Session, ctx, conv_id: str) -> ChatConversation:
    require_agent(db, ctx)
    c = _conv_row(db, ctx, conv_id)
    if c.status != "closed":
        return c
    c.status, c.assignee_id = "open", ctx.user.id
    c.closed_at = c.closed_by = None
    c.agent_joined_at = c.agent_joined_at or utcnow()
    convs.add_message(db, c, "system", f"{_agent_name(ctx)} reopened the chat.", author_id=ctx.user.id,
                      meta={"event": "reopened"})
    return c


def mark_read(db: Session, ctx, conv_id: str) -> None:
    ctx.require(Perm.CHAT_READ)
    c = _conv_row(db, ctx, conv_id)
    c.unread_agent = 0


# ------------------------------------------------------------------ canned responses


def canned_out(r: ChatCannedResponse) -> dict:
    return {"id": r.id, "shortcut": r.shortcut, "title": r.title, "body": r.body}


def list_canned(db: Session, ctx) -> list[dict]:
    ctx.require(Perm.CHAT_READ)
    return [canned_out(r) for r in db.scalars(select(ChatCannedResponse).where(
        ChatCannedResponse.application_id == ctx.application_id).order_by(ChatCannedResponse.shortcut))]


def save_canned(db: Session, ctx, data: CannedIn, canned_id: str | None = None) -> ChatCannedResponse:
    ctx.require(Perm.CHAT_REPLY)
    clash = db.scalar(select(ChatCannedResponse).where(ChatCannedResponse.application_id == ctx.application_id,
                                                       ChatCannedResponse.shortcut == data.shortcut))
    if clash is not None and clash.id != canned_id:
        raise ValidationFailed(f"/{data.shortcut} is already used", code="DUPLICATE_SHORTCUT")
    if canned_id:
        r = db.get(ChatCannedResponse, canned_id)
        if r is None or r.application_id != ctx.application_id:
            raise NotFound("Canned response not found")
    else:
        r = ChatCannedResponse(organization_id=ctx.organization_id, application_id=ctx.application_id)
        db.add(r)
    r.shortcut, r.title, r.body = data.shortcut, data.title.strip(), data.body.strip()
    db.flush()
    return r


def delete_canned(db: Session, ctx, canned_id: str) -> None:
    ctx.require(Perm.CHAT_REPLY)
    r = db.get(ChatCannedResponse, canned_id)
    if r is None or r.application_id != ctx.application_id:
        raise NotFound("Canned response not found")
    db.delete(r)

"""Website chatbots: templates, CRUD, publishing, the embed snippet and plan limits (chatbots)."""
import secrets

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.embed import validate_domains
from app.core.errors import ValidationFailed
from app.core.permissions import Perm
from app.models import ApplicationSettings, Organization
from app.models.chat import ChatBot, ChatConversation, ChatKnowledgeSource
from app.schemas.chat import Appearance, BotCreate, BotUpdate, BusinessHours, LeadCapture, Proactive
from app.services import audit_service
from app.services.billing import plans
from app.services.chat import knowledge

TEMPLATES: dict[str, dict] = {
    "website_assistant": {
        "name": "Website assistant / FAQ",
        "description": "Answers questions about your business from your website, FAQs and documents.",
        "instructions": (
            "Goal: answer visitors' questions about our products, services and policies quickly and accurately.\n"
            "Tone: friendly, clear and concise.\n"
            "Do: answer from the knowledge; point to the right page when there is one; offer to connect the "
            "visitor with the team for anything you can't answer.\n"
            "Don't: guess, promise discounts, or discuss topics unrelated to our business."),
        "welcome": "Hi there! 👋 I'm the virtual assistant. Ask me anything about us.",
        "chips": ["What do you offer?", "Pricing", "Talk to a human"],
        "lead_mode": "when_needed", "fallback": "human",
    },
    "lead_qualifier": {
        "name": "Lead qualifier",
        "description": "Finds out what visitors need, qualifies them and captures their details for sales.",
        "instructions": (
            "Goal: understand what the visitor needs and capture qualified leads for the sales team.\n"
            "Ask, one question at a time and only when it fits: what they're looking for, their company or use "
            "case, their timeline and rough budget.\n"
            "When they're interested, offer a call or demo with the team and ask for their details.\n"
            "Tone: warm, curious and brief. Answer questions from the knowledge before asking your own.\n"
            "Don't: pressure the visitor or quote prices that aren't in the knowledge."),
        "welcome": "Hi! 👋 Looking for something specific? I can help you find the right option.",
        "chips": ["I'd like a quote", "Book a demo", "Just browsing"],
        "lead_mode": "after", "fallback": "collect",
    },
    "support_desk": {
        "name": "Support desk",
        "description": "Solves common support questions and hands tricky ones to your team.",
        "instructions": (
            "Goal: resolve customers' support questions using the knowledge (help articles, policies).\n"
            "Steps: understand the problem, give clear step-by-step help from the knowledge, check it worked.\n"
            "Hand off to a person when the customer asks, when they're frustrated, or for account-specific "
            "issues (orders, refunds, billing) you can't see.\n"
            "Tone: patient, empathetic and precise.\n"
            "Don't: ask for passwords or payment details, or promise refunds."),
        "welcome": "Hi! I'm here to help. What can I help you with today?",
        "chips": ["Track my order", "Returns & refunds", "Talk to support"],
        "lead_mode": "when_needed", "fallback": "human",
    },
    "appointment": {
        "name": "Appointment booking request",
        "description": "Collects appointment requests (service, preferred date and time) for your team to confirm.",
        "instructions": (
            "Goal: help visitors request an appointment. You can't see the calendar, so you collect a request "
            "and the team confirms it.\n"
            "Ask for: the service they want, their preferred day and time, and any notes. Then ask for their "
            "contact details so the team can confirm.\n"
            "Answer questions about services, location and opening hours from the knowledge.\n"
            "Don't: confirm a booking yourself or promise a specific slot; say the team will confirm."),
        "welcome": "Hi! 👋 Would you like to book an appointment? I can take your request.",
        "chips": ["Book an appointment", "Opening hours", "Services"],
        "lead_mode": "when_needed", "fallback": "collect",
    },
    "ecommerce": {
        "name": "E-commerce helper",
        "description": "Helps shoppers find products, answers shipping and returns questions, and recovers sales.",
        "instructions": (
            "Goal: help shoppers find the right product and buy with confidence.\n"
            "Do: recommend products from the knowledge that match what they describe, with links when available; "
            "answer shipping, payment and returns questions from the policies.\n"
            "Hand off order-specific questions (where is my order, refunds for a specific order) to the team.\n"
            "Tone: upbeat, helpful and concise.\n"
            "Don't: invent stock, prices, discount codes or delivery dates."),
        "welcome": "Hi! 🛍️ Need help finding something? Tell me what you're looking for.",
        "chips": ["Shipping & delivery", "Returns", "Help me choose"],
        "lead_mode": "when_needed", "fallback": "human",
    },
}


def templates() -> list[dict]:
    return [{"key": k, "name": t["name"], "description": t["description"], "welcome_message": t["welcome"],
             "quick_replies": t["chips"]} for k, t in TEMPLATES.items()]


def snippet(bot: ChatBot) -> str:
    return (f'<script src="{settings.BACKEND_PUBLIC_URL.rstrip("/")}/embed/chat.js" '
            f'data-bot="{bot.public_key}" async></script>')


def _count(db: Session, organization_id: str) -> int:
    return db.scalar(select(func.count()).select_from(ChatBot).where(ChatBot.organization_id == organization_id)) or 0


plans.register_usage_counter("chatbots", _count)


def business_name(db: Session, bot: ChatBot) -> str:
    s = db.scalar(select(ApplicationSettings.business_name).where(
        ApplicationSettings.application_id == bot.application_id))
    if s:
        return s
    org = db.get(Organization, bot.organization_id)
    return org.name if org else "us"


def branding_hidden(db: Session, organization_id: str) -> bool:
    return plans.current_plan(db, organization_id)["key"] == plans.PRO


def bot_out(db: Session, b: ChatBot, with_counts: bool = True) -> dict:
    out = {"id": b.id, "name": b.name, "status": b.status, "template": b.template, "public_key": b.public_key,
           "avatar_url": b.avatar_url, "instructions": b.instructions, "welcome_message": b.welcome_message,
           "quick_replies": b.quick_replies or [], "language": b.language, "fallback": b.fallback,
           "lead_capture": LeadCapture.model_validate(b.lead_capture or {}).model_dump(),
           "business_hours": BusinessHours.model_validate(b.business_hours or {}).model_dump(),
           "allowed_domains": b.allowed_domains or [],
           "appearance": Appearance.model_validate(b.appearance or {}).model_dump(),
           "proactive": Proactive.model_validate(b.proactive or {}).model_dump(), "routing": b.routing,
           "knowledge_chars": b.knowledge_chars,
           "knowledge_mode": "inline" if b.knowledge_chars <= settings.CHAT_KNOWLEDGE_INLINE_CHARS else "retrieval",
           "snippet": snippet(b), "embed_url": f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}/embed/chat/{b.public_key}",
           "branding_hidden": branding_hidden(db, b.organization_id),
           "created_at": b.created_at.isoformat(), "updated_at": b.updated_at.isoformat()}
    if with_counts:
        out["source_count"] = db.scalar(select(func.count()).select_from(ChatKnowledgeSource).where(
            ChatKnowledgeSource.bot_id == b.id)) or 0
        out["conversation_count"] = db.scalar(select(func.count()).select_from(ChatConversation).where(
            ChatConversation.bot_id == b.id)) or 0
    return out


def list_bots(db: Session, ctx) -> list[dict]:
    ctx.require(Perm.CHAT_READ)
    rows = db.scalars(select(ChatBot).where(ChatBot.application_id == ctx.application_id)
                      .order_by(ChatBot.created_at.desc()))
    return [bot_out(db, b) for b in rows]


def _audit(db: Session, ctx, action: str, b: ChatBot) -> None:
    audit_service.record(db, f"chat.bot_{action}", actor_user_id=ctx.user.id if ctx.user else None,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="chat_bot", target_id=b.id, summary=b.name)


def create_bot(db: Session, ctx, data: BotCreate) -> ChatBot:
    ctx.require(Perm.CHAT_WRITE)
    plans.check_limit(db, ctx.organization_id, "chatbots", _count(db, ctx.organization_id))
    t = TEMPLATES.get(data.template or "")
    if data.template and t is None:
        raise ValidationFailed("Unknown template", code="UNKNOWN_TEMPLATE")
    t = t or TEMPLATES["website_assistant"]
    domains = validate_domains([data.website])
    if not domains:
        raise ValidationFailed("Add the website where this chat will appear", code="DOMAIN_REQUIRED",
                               details={"field": "website"})
    app_tz = getattr(ctx.application, "timezone", None) or "UTC"
    lead = LeadCapture(mode=t["lead_mode"]).model_dump()
    b = ChatBot(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                public_key=secrets.token_urlsafe(18)[:24], status="draft", template=data.template if data.template
                else None, instructions=t["instructions"], welcome_message=t["welcome"], quick_replies=list(t["chips"]),
                language="auto", fallback=t["fallback"], lead_capture=lead,
                business_hours=BusinessHours(timezone=app_tz).model_dump(), allowed_domains=domains,
                appearance=Appearance(title=data.name.strip()[:60]).model_dump(), proactive=Proactive().model_dump(),
                routing="broadcast", routing_cursor=0, knowledge_chars=0,
                created_by_id=ctx.user.id if ctx.user else None)
    db.add(b)
    db.flush()
    _audit(db, ctx, "created", b)
    # Whoever creates the first bot usually answers its chats: make them an agent if a seat is free.
    from app.services.chat import inbox

    if ctx.user is not None and ctx.has(Perm.CHAT_REPLY):
        inbox.try_add_agent(db, ctx.organization_id, ctx.application_id, ctx.user.id)
    return b


def update_bot(db: Session, ctx, bot_id: str, data: BotUpdate) -> ChatBot:
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    changes = data.model_dump(exclude_unset=True)
    for k, v in changes.items():
        if v is None and k not in ("avatar_url",):
            continue
        if k == "allowed_domains":
            v = validate_domains(v)
        elif isinstance(v, str) and k != "instructions":
            v = v.strip()
        setattr(b, k, v)
    if b.status == "live":
        _validate_live(b)
    db.flush()
    return b


def _validate_live(b: ChatBot) -> None:
    missing = []
    if len((b.instructions or "").strip()) < 10:
        missing.append("instructions")
    if not (b.welcome_message or "").strip():
        missing.append("a welcome message")
    if missing:
        raise ValidationFailed("Before going live, add " + " and ".join(missing), code="BOT_INCOMPLETE")
    if not b.allowed_domains:
        # A live bot spends the wallet on every AI reply, so it only runs on websites the owner listed.
        raise ValidationFailed("Add the website where this chat will appear before going live",
                               code="DOMAIN_REQUIRED", details={"field": "allowed_domains"})


def set_status(db: Session, ctx, bot_id: str, live: bool) -> ChatBot:
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    if live:
        _validate_live(b)
    b.status = "live" if live else "draft"
    _audit(db, ctx, "published" if live else "unpublished", b)
    return b


def delete_bot(db: Session, ctx, bot_id: str) -> None:
    ctx.require(Perm.CHAT_WRITE)
    b = knowledge.bot_row(db, ctx, bot_id)
    _audit(db, ctx, "deleted", b)
    db.delete(b)


def snapshot(db: Session, b: ChatBot) -> dict:
    """What the AI needs to know about the bot."""
    return {"id": b.id, "name": b.name, "instructions": b.instructions, "language": b.language,
            "fallback": b.fallback, "welcome_message": b.welcome_message, "business_name": business_name(db, b)}

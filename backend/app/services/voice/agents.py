"""AI calling agents: templates, CRUD, activation and where each agent is used."""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models.voice import VoiceAgent, VoiceCampaign
from app.schemas.voice_ai import AgentCreate, AgentListItem, AgentOut, AgentUpdate
from app.services import audit_service

ACTIVE_CAMPAIGNS = ("scheduled", "queued", "sending", "paused")
# Changing any of these changes how the agent behaves on a call, so the version goes up.
BEHAVIOUR = ("language", "voice", "goal", "greeting", "instructions", "knowledge", "outcome_fields",
             "transfer_number", "max_call_minutes")
NULLABLE = ("goal", "knowledge", "transfer_number")


def _f(key: str, label: str, type_: str = "text", description: str | None = None, options: list | None = None):
    return {"key": key, "label": label, "type": type_, "options": options, "description": description}


TEMPLATES: dict[str, dict] = {
    "lead_qualification": {
        "name": "Lead qualification",
        "description": "Calls new leads, finds out what they need and whether they're ready to buy.",
        "goal": "Qualify the lead: need, budget, timeline and decision maker, then book a follow-up.",
        "greeting": "Hi {{first_name}}, this is Maya calling from {{business_name}}. You recently showed interest "
                    "in what we do. Do you have two minutes?",
        "instructions": (
            "You are Maya, a friendly sales assistant for {{business_name}}.\n"
            "Goal: understand whether this lead is a good fit and what should happen next.\n"
            "Ask, one at a time and only if it fits the conversation:\n"
            "- What problem they want to solve and how they handle it today.\n"
            "- Their rough budget.\n"
            "- When they want to start.\n"
            "- Whether they decide alone or with someone else.\n"
            "Tone: warm, curious and brief. Listen more than you talk.\n"
            "Do: summarise what you heard before you wrap up; offer a call with a specialist if they're interested.\n"
            "Don't: quote prices that aren't in the knowledge, pressure them, or keep going if they want to stop."),
        "fields": [_f("need", "What they need", description="The problem or use case in their words"),
                   _f("budget", "Budget", description="Rough budget if they shared one"),
                   _f("timeline", "Timeline", "choice", options=["This month", "1-3 months", "Later", "Unknown"]),
                   _f("decision_maker", "Decision maker", "yes_no", "Whether they make the decision themselves")],
    },
    "appointment": {
        "name": "Appointment reminder & booking",
        "description": "Confirms upcoming appointments, or books and reschedules them.",
        "goal": "Confirm, reschedule or book the appointment and capture the agreed date.",
        "greeting": "Hello {{first_name}}, this is a quick call from {{business_name}} about your appointment.",
        "instructions": (
            "You help customers of {{business_name}} confirm, book or reschedule appointments.\n"
            "Steps: confirm you're speaking to the right person, then ask whether the appointment still works. "
            "If it doesn't, ask for a better day and time and repeat it back.\n"
            "Tone: polite, efficient and calm.\n"
            "Do: repeat the final date and time clearly before you say goodbye.\n"
            "Don't: promise slots or services that aren't listed in the knowledge; say the team will confirm "
            "by message instead."),
        "fields": [_f("status", "Appointment status", "choice", options=["Confirmed", "Rescheduled", "Cancelled",
                                                                          "Booked new", "No decision"]),
                   _f("appointment_at", "Agreed date", "date", "The date agreed on the call, if any"),
                   _f("notes", "Notes", description="Anything the team should know before the visit")],
    },
    "feedback": {
        "name": "Feedback survey",
        "description": "Asks recent customers how it went and records a score and comments.",
        "goal": "Get a 0-10 recommendation score and the main reason behind it.",
        "greeting": "Hi {{first_name}}, this is {{business_name}}. Could I ask you two quick questions about "
                    "your recent experience?",
        "instructions": (
            "You run a very short feedback survey for {{business_name}}.\n"
            "1. Ask how likely they are to recommend us to a friend, from 0 to 10.\n"
            "2. Ask the main reason for that score.\n"
            "3. If the score is 6 or lower, apologise and ask what we could do better, and offer a call back "
            "from the team.\n"
            "Tone: grateful and brief. Thank them at the end.\n"
            "Don't: argue with feedback or offer compensation."),
        "fields": [_f("score", "Recommendation score (0-10)", "number"),
                   _f("reason", "Main reason"),
                   _f("wants_follow_up", "Wants a follow-up", "yes_no")],
    },
    "payment_reminder": {
        "name": "Payment reminder",
        "description": "Reminds customers about a due payment and records when they plan to pay.",
        "goal": "Remind the customer of the due payment and capture a promised payment date.",
        "greeting": "Hello {{first_name}}, this is a courtesy call from {{business_name}} about your account.",
        "instructions": (
            "You remind customers of {{business_name}} about a payment that is due.\n"
            "Confirm you're speaking to the right person before discussing the account. Explain that a payment "
            "is due and ask when they plan to pay. If they have a problem paying, be understanding and offer a "
            "call back from the accounts team.\n"
            "Tone: respectful, never threatening.\n"
            "Do: tell them they can pay using the link or methods in the knowledge.\n"
            "Don't: take payment on the call, or ask for card numbers, OTPs or passwords. Don't discuss the "
            "account with anyone else."),
        "fields": [_f("promise_to_pay", "Promised to pay", "yes_no"),
                   _f("promised_date", "Promised date", "date"),
                   _f("issue", "Problem paying", description="Any reason they gave for not paying yet")],
    },
}


def templates() -> list[dict]:
    return [{"key": k, "name": t["name"], "description": t["description"], "goal": t["goal"],
             "outcome_fields": t["fields"]} for k, t in TEMPLATES.items()]


def _audit(db: Session, ctx, action: str, a: VoiceAgent) -> None:
    audit_service.record(db, f"voice.agent_{action}", actor_user_id=ctx.user.id if ctx.user else None,
                         organization_id=ctx.organization_id, application_id=ctx.application_id,
                         target_type="voice_agent", target_id=a.id, summary=a.name)


def agent_row(db: Session, ctx, agent_id: str) -> VoiceAgent:
    a = db.scalar(select(VoiceAgent).where(VoiceAgent.id == agent_id, VoiceAgent.application_id == ctx.application_id))
    if a is None:
        raise NotFound("Agent not found")
    return a


def used_by(db: Session, agent_ids: list[str]) -> dict[str, list[dict]]:
    if not agent_ids:
        return {}
    out: dict[str, list[dict]] = {}
    for c in db.scalars(select(VoiceCampaign).where(VoiceCampaign.agent_id.in_(agent_ids),
                                                    VoiceCampaign.status != "automation",
                                                    VoiceCampaign.message_type == "ai_agent")
                        .order_by(VoiceCampaign.updated_at.desc())):
        out.setdefault(c.agent_id, []).append({"id": c.id, "name": c.name, "status": c.status})
    return out


def agent_out(db: Session, a: VoiceAgent) -> AgentOut:
    out = AgentOut.model_validate(a)
    out.used_by = used_by(db, [a.id]).get(a.id, [])
    return out


def list_agents(db: Session, ctx) -> list[AgentListItem]:
    ctx.require(Perm.CAMPAIGNS_READ)
    rows = list(db.scalars(select(VoiceAgent).where(VoiceAgent.application_id == ctx.application_id)
                           .order_by(VoiceAgent.updated_at.desc())))
    uses = used_by(db, [r.id for r in rows])
    items = []
    for r in rows:
        it = AgentListItem.model_validate(r)
        it.used_by = uses.get(r.id, [])
        items.append(it)
    return items


def _count(db: Session, organization_id: str) -> int:
    return db.scalar(select(func.count()).select_from(VoiceAgent).where(
        VoiceAgent.organization_id == organization_id)) or 0


def _check_limit(db: Session, ctx) -> None:
    from app.services.billing import plans

    plans.check_limit(db, ctx.organization_id, "voice_agents", _count(db, ctx.organization_id))


def _default_language(ctx) -> str:
    country = getattr(ctx.application, "default_country", None) or ""
    return "en-US" if country in ("US", "AE") else "en-IN"


def create_agent(db: Session, ctx, data: AgentCreate) -> VoiceAgent:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    _check_limit(db, ctx)
    t = TEMPLATES.get(data.template or "")
    if data.template and t is None:
        raise ValidationFailed("Unknown template", code="UNKNOWN_TEMPLATE")
    a = VoiceAgent(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                   status="draft", template=data.template if t else None,
                   language=data.language or _default_language(ctx), voice="female",
                   goal=t["goal"] if t else None, greeting=t["greeting"] if t else "",
                   instructions=t["instructions"] if t else "", knowledge=None,
                   outcome_fields=[dict(f) for f in t["fields"]] if t else [], max_call_minutes=5, version=1,
                   created_by_id=ctx.user.id if ctx.user else None)
    db.add(a)
    db.flush()
    _audit(db, ctx, "created", a)
    return a


def update_agent(db: Session, ctx, agent_id: str, data: AgentUpdate) -> VoiceAgent:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = agent_row(db, ctx, agent_id)
    changes = data.model_dump(exclude_unset=True)
    behaviour = False
    for k, v in changes.items():
        if v is None and k not in NULLABLE:
            continue
        if isinstance(v, str) and k != "knowledge":
            v = v.strip()
        if k in NULLABLE and isinstance(v, str) and not v.strip():
            v = None
        if getattr(a, k) != v:
            behaviour = behaviour or k in BEHAVIOUR
            setattr(a, k, v)
    if behaviour:
        a.version = (a.version or 1) + 1
    if a.status == "active":
        _validate_active(a)
    db.flush()
    return a


def _validate_active(a: VoiceAgent) -> None:
    missing = []
    if not (a.greeting or "").strip():
        missing.append("a greeting")
    if len((a.instructions or "").strip()) < 20:
        missing.append("instructions (a few sentences at least)")
    if missing:
        raise ValidationFailed("Before activating, add " + " and ".join(missing), code="AGENT_INCOMPLETE")


def set_status(db: Session, ctx, agent_id: str, active: bool) -> VoiceAgent:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = agent_row(db, ctx, agent_id)
    if active:
        _validate_active(a)
    elif db.scalar(select(VoiceCampaign.id).where(VoiceCampaign.agent_id == a.id,
                                                  VoiceCampaign.message_type == "ai_agent",
                                                  VoiceCampaign.status.in_(ACTIVE_CAMPAIGNS)).limit(1)):
        raise Conflict("A scheduled or running campaign uses this agent", code="AGENT_IN_USE")
    a.status = "active" if active else "draft"
    _audit(db, ctx, "activated" if active else "deactivated", a)
    return a


def duplicate_agent(db: Session, ctx, agent_id: str) -> VoiceAgent:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    s = agent_row(db, ctx, agent_id)
    _check_limit(db, ctx)
    a = VoiceAgent(organization_id=ctx.organization_id, application_id=ctx.application_id,
                   name=f"{s.name} (copy)"[:120], status="draft", template=s.template, language=s.language,
                   voice=s.voice, goal=s.goal, greeting=s.greeting, instructions=s.instructions, knowledge=s.knowledge,
                   outcome_fields=[dict(f) for f in (s.outcome_fields or [])], transfer_number=s.transfer_number,
                   max_call_minutes=s.max_call_minutes, version=1, created_by_id=ctx.user.id if ctx.user else None)
    db.add(a)
    db.flush()
    _audit(db, ctx, "duplicated", a)
    return a


def delete_agent(db: Session, ctx, agent_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = agent_row(db, ctx, agent_id)
    if db.scalar(select(VoiceCampaign.id).where(VoiceCampaign.agent_id == a.id,
                                                VoiceCampaign.status.in_(ACTIVE_CAMPAIGNS)).limit(1)):
        raise Conflict("A scheduled or running campaign uses this agent", code="AGENT_IN_USE")
    _audit(db, ctx, "deleted", a)
    db.delete(a)


def snapshot(a: VoiceAgent) -> dict:
    """Everything a call needs from the agent, frozen when a campaign launches."""
    return {"id": a.id, "version": a.version, "name": a.name, "language": a.language, "voice": a.voice,
            "goal": a.goal, "greeting": a.greeting, "instructions": a.instructions, "knowledge": a.knowledge,
            "outcome_fields": list(a.outcome_fields or []), "transfer_number": a.transfer_number,
            "max_call_minutes": a.max_call_minutes}


def _register_counters() -> None:
    from app.services.billing import plans

    if hasattr(plans, "register_usage_counter"):
        plans.register_usage_counter("voice_agents", _count)


_register_counters()

"""AI agents: configuration (validated against this application's data and the owner's permissions), templates,
"Describe what you want" drafting, schedules (in the application's timezone) and CRUD.

An agent runs as its owner, with the owner's permissions at run time, limited to its allowed tools."""
import re
from datetime import datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound, ValidationFailed
from app.core.permissions import Perm
from app.models import OrganizationMember
from app.models.ai_team import AgentRun, AgentSlackDestination, AiAgent
from app.services import audit_service
from app.services.ai_team import llm, lookup
from app.services.ai_team.registry import REGISTRY, ToolError
from app.services.ai_team.templates import EVENT_FILTERS, EVENTS, TEMPLATES, guess_template
from app.utils.time import utcnow

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
# Agents report through their destinations; they never create other agents or post to arbitrary channels.
AGENT_EXCLUDED_TOOLS = {"create_ai_agent", "post_to_slack", "platform_help"}
MAX_AGENTS = 50


def agent_tools() -> list[str]:
    return [n for n in REGISTRY if n not in AGENT_EXCLUDED_TOOLS]


# ------------------------------------------------------------------ trigger and schedule


def describe_trigger(t: dict) -> str:
    if (t or {}).get("type") == "schedule":
        at = t.get("time") or "09:00"
        if t.get("every") == "weekly":
            return f"Every {DAYS[int(t.get('day') or 0)]} at {at}"
        if t.get("every") == "hours":
            n = int(t.get("hours") or 1)
            return f"Every {n} hour{'s' if n != 1 else ''}"
        return f"Every day at {at}"
    events = (t or {}).get("events") or []
    return " or ".join(EVENTS.get(e, e) for e in events) or "No trigger"


def _hhmm(v) -> tuple[int, int]:
    m = re.fullmatch(r"([01]?\d|2[0-3]):([0-5]\d)", str(v or ""))
    if not m:
        raise ValidationFailed("Use a time like 09:30", code="INVALID_TRIGGER")
    return int(m.group(1)), int(m.group(2))


def next_run(agent: AiAgent, ctx_or_app, after: datetime | None = None) -> datetime | None:
    """The next scheduled time after `after`, computed in the application's timezone."""
    t = agent.trigger or {}
    if t.get("type") != "schedule":
        return None
    now = after or utcnow()
    if t.get("every") == "hours":
        return now + timedelta(hours=max(1, int(t.get("hours") or 1)))
    tz = lookup.app_tz(ctx_or_app)
    h, m = _hhmm(t.get("time") or "09:00")
    local = now.astimezone(tz)
    cand = datetime.combine(local.date(), time(h, m), tz)
    if t.get("every") == "weekly":
        cand += timedelta(days=(int(t.get("day") or 0) - cand.weekday()) % 7)
        while cand <= local:
            cand += timedelta(days=7)
    else:
        while cand <= local:
            cand += timedelta(days=1)
    return cand.astimezone(now.tzinfo)


def _owned(db: Session, model, obj_id: str, app_id: str) -> bool:
    o = db.get(model, obj_id)
    return o is not None and o.application_id == app_id


def clean_trigger(db: Session, ctx, raw: dict | None) -> dict:
    raw = raw or {}
    if raw.get("type") == "schedule":
        every = raw.get("every") or "daily"
        if every not in ("daily", "weekly", "hours"):
            raise ValidationFailed("Choose daily, weekly or every few hours", code="INVALID_TRIGGER")
        out = {"type": "schedule", "every": every}
        if every == "hours":
            try:
                hours = int(raw.get("hours") or 0)
            except (TypeError, ValueError):
                hours = 0
            if not 1 <= hours <= 168:
                raise ValidationFailed("Run every 1 to 168 hours", code="INVALID_TRIGGER")
            out["hours"] = hours
        else:
            h, m = _hhmm(raw.get("time") or "09:00")
            out["time"] = f"{h:02d}:{m:02d}"
            if every == "weekly":
                day = int(raw.get("day") or 0)
                if not 0 <= day <= 6:
                    raise ValidationFailed("Choose a day of the week", code="INVALID_TRIGGER")
                out["day"] = day
        return out
    events = raw.get("events") or ([raw["event"]] if raw.get("event") else [])
    events = list(dict.fromkeys(e for e in events if e))
    if not events or any(e not in EVENTS for e in events) or len(events) > 4:
        raise ValidationFailed("Choose what starts the agent", code="INVALID_TRIGGER")
    allowed = {k for e in events for k in EVENT_FILTERS[e]}
    filters = {k: v for k, v in (raw.get("filters") or {}).items() if k in allowed and v not in (None, "", False)}
    from app.models import ChatBot, LeadForm, Pipeline, PipelineStage

    for key, model in (("form_id", LeadForm), ("bot_id", ChatBot), ("pipeline_id", Pipeline),
                       ("stage_id", PipelineStage)):
        if filters.get(key) and not _owned(db, model, filters[key], ctx.application_id):
            raise ValidationFailed(f"That {key.split('_')[0]} isn't in this application", code="INVALID_TRIGGER")
    if filters.get("interest") and filters["interest"] not in ("hot", "warm", "cold", "not_interested"):
        raise ValidationFailed("Choose an interest level", code="INVALID_TRIGGER")
    if "failed_only" in filters:
        filters["failed_only"] = bool(filters["failed_only"])
    return {"type": "event", "events": events, "filters": filters}


def clean_destinations(db: Session, ctx, raw: dict | None) -> tuple[dict, list[dict]]:
    raw = raw or {}
    emails = list(dict.fromkeys(raw.get("email_user_ids") or []))[:10]
    if emails:
        members = set(db.scalars(select(OrganizationMember.user_id).where(
            OrganizationMember.organization_id == ctx.organization_id, OrganizationMember.user_id.in_(emails))))
        if set(emails) - members:
            raise ValidationFailed("Email reports can only go to members of this organization", code="INVALID_DESTINATION")
    channels = []
    for ch in (raw.get("slack_channels") or [])[:5]:
        from app.services.ai_team import slack

        try:
            found = slack.find_channel(db, ctx.organization_id, str(ch.get("id") or ch.get("name") or ""))
        except ToolError as exc:
            raise ValidationFailed(exc.message, code="INVALID_DESTINATION") from exc
        channels.append({"id": found["id"], "name": found["name"]})
    return {"in_app": bool(raw.get("in_app", True)), "email_user_ids": emails}, channels


def clean_config(db: Session, ctx, cfg: dict) -> tuple[dict, list[dict]]:
    name = str(cfg.get("name") or "").strip()
    if not 1 <= len(name) <= 120:
        raise ValidationFailed("Give the agent a name (up to 120 characters)", code="INVALID_AGENT")
    instructions = str(cfg.get("instructions") or "").strip()
    if len(instructions) > 4000:
        raise ValidationFailed("Keep the instructions under 4,000 characters", code="INVALID_AGENT")
    tools_ = list(dict.fromkeys(cfg.get("allowed_tools") or []))
    unknown = [t for t in tools_ if t not in agent_tools()]
    if unknown:
        raise ValidationFailed(f"Unknown or unavailable tools: {', '.join(unknown)}", code="INVALID_AGENT")
    if not tools_:
        raise ValidationFailed("Allow at least one tool", code="INVALID_AGENT")
    missing = [REGISTRY[t].label for t in tools_ if not all(ctx.has(p) for p in REGISTRY[t].perms)]
    if missing:
        raise ValidationFailed(f"Your role can't use: {', '.join(missing)}. An agent can only do what its owner can.",
                               code="TOOL_NOT_PERMITTED")
    mode = cfg.get("mode") or "approve"
    if mode not in ("auto", "approve"):
        raise ValidationFailed("Choose auto or approval mode", code="INVALID_AGENT")
    dest, channels = clean_destinations(db, ctx, cfg.get("destinations"))
    tpl = cfg.get("template") if cfg.get("template") in TEMPLATES else None
    return {"name": name, "description": str(cfg.get("description") or "").strip()[:500], "template": tpl,
            "instructions": instructions, "trigger": clean_trigger(db, ctx, cfg.get("trigger")),
            "allowed_tools": tools_, "mode": mode, "destinations": dest}, channels


# ------------------------------------------------------------------ drafting


DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string"}, "description": {"type": "string"}, "instructions": {"type": "string"},
        "trigger_type": {"type": "string", "enum": ["event", "schedule"]},
        "events": {"type": "array", "items": {"type": "string", "enum": list(EVENTS)}},
        "every": {"type": "string", "enum": ["daily", "weekly", "hours"]},
        "time": {"type": "string"}, "day": {"type": "integer"}, "hours": {"type": "integer"},
        "allowed_tools": {"type": "array", "items": {"type": "string"}},
        "mode": {"type": "string", "enum": ["auto", "approve"]},
    },
    "required": ["name", "instructions", "trigger_type", "allowed_tools", "mode"],
}


def from_template(key: str) -> dict:
    t = TEMPLATES.get(key)
    if t is None:
        raise ValidationFailed("Unknown template", code="INVALID_TEMPLATE")
    return {"name": t["name"], "description": t["description"], "template": key, "instructions": t["instructions"],
            "trigger": dict(t["trigger"]), "allowed_tools": list(t["allowed_tools"]), "mode": t["mode"],
            "destinations": {"in_app": True, "email_user_ids": []}}


def draft_from_prompt(db: Session, ctx, prompt: str) -> dict:
    """“Describe what you want” → an agent configuration for the person to review (nothing is saved)."""
    prompt = prompt.strip()[:2000]
    if not prompt:
        raise ValidationFailed("Describe what the agent should do", code="INVALID_AGENT")
    if not llm.configured():
        key = guess_template(prompt) or "daily_report"
        cfg = from_template(key)
        cfg["instructions"] = f"{cfg['instructions']}\n\nAlso: {prompt}"
        cfg["simulated"] = True
        return cfg
    tools_ = [t for t in agent_tools() if all(ctx.has(p) for p in REGISTRY[t].perms)]
    catalog = "\n".join(f"- {t}: {REGISTRY[t].description}" for t in tools_)
    from app.services.ai_team import metering

    metering.ensure_can_afford(db, ctx.organization_id)
    data, turn = llm.structured(
        "You configure AI agents for Signalcraft, a marketing and sales platform. From the person's description, "
        "choose a short name, clear step-by-step instructions, what starts the agent (an event or a schedule in "
        "the application's timezone) and the smallest set of tools it needs. Prefer mode 'approve' whenever the "
        f"agent changes data or drafts messages.\n\nEvents: {', '.join(EVENTS)}.\nTools:\n{catalog}",
        prompt, "agent_config", DRAFT_SCHEMA, model=llm.smart_model())  # building an agent: the flagship
    meter = metering.Meter()
    meter.add(turn)
    import uuid

    metering.charge(db, ctx.organization_id, ctx.application_id, meter, key=f"ai:draft:{uuid.uuid4().hex}",
                    description="AI Assistant: draft an agent", reference_type="ai_agent_draft",
                    reference_id=ctx.user.id if ctx.user else "")
    trigger = ({"type": "schedule", "every": data.get("every") or "daily", "time": data.get("time") or "09:00",
                "day": data.get("day") or 0, "hours": data.get("hours") or 24}
               if data.get("trigger_type") == "schedule" else
               {"type": "event", "events": [e for e in data.get("events") or [] if e in EVENTS][:4], "filters": {}})
    return {"name": str(data.get("name") or "New agent")[:120], "description": str(data.get("description") or "")[:500],
            "template": None, "instructions": str(data.get("instructions") or prompt)[:4000], "trigger": trigger,
            "allowed_tools": [t for t in data.get("allowed_tools") or [] if t in tools_],
            "mode": data.get("mode") if data.get("mode") in ("auto", "approve") else "approve",
            "destinations": {"in_app": True, "email_user_ids": []}}


def draft_config(db: Session, ctx, a: dict) -> dict:
    """Used by the assistant's create_ai_agent tool: a template, or a description drafted into a config."""
    if a.get("template"):
        cfg = from_template(a["template"])
    else:
        cfg = draft_from_prompt(db, ctx, a.get("description") or a.get("instructions") or a.get("name") or "")
    cfg.pop("simulated", None)
    if a.get("name"):
        cfg["name"] = a["name"]
    if a.get("instructions") and a.get("template"):
        cfg["instructions"] = a["instructions"]
    if not cfg.get("allowed_tools"):
        cfg["allowed_tools"] = ["analytics_summary"]
    cleaned, _ = clean_config(db, ctx, cfg)
    return cleaned


# ------------------------------------------------------------------ CRUD


def get(db: Session, ctx, agent_id: str) -> AiAgent:
    a = db.get(AiAgent, agent_id)
    if a is None or a.application_id != ctx.application_id:
        raise NotFound("Agent not found")
    return a


def channels_of(db: Session, agent_id: str) -> list[dict]:
    return [{"id": d.channel_id, "name": d.channel_name} for d in db.scalars(
        select(AgentSlackDestination).where(AgentSlackDestination.agent_id == agent_id)
        .order_by(AgentSlackDestination.created_at))]


def _set_channels(db: Session, ctx, agent: AiAgent, channels: list[dict]) -> None:
    db.execute(AgentSlackDestination.__table__.delete().where(AgentSlackDestination.agent_id == agent.id))
    for ch in channels:
        db.add(AgentSlackDestination(organization_id=ctx.organization_id, application_id=ctx.application_id,
                                     agent_id=agent.id, channel_id=ch["id"], channel_name=ch["name"]))


def out(db: Session, a: AiAgent, stats: dict | None = None) -> dict:
    t = TEMPLATES.get(a.template or "")
    return {"id": a.id, "name": a.name, "description": a.description, "template": a.template,
            "instructions": a.instructions, "trigger": a.trigger, "trigger_label": describe_trigger(a.trigger),
            "allowed_tools": a.allowed_tools, "mode": a.mode,
            "destinations": {**(a.destinations or {}), "slack_channels": channels_of(db, a.id)},
            "enabled": a.enabled, "owner_id": a.owner_id, "owner_name": lookup.user_name(db, a.owner_id),
            "flow": t["flow"] if t else ["Trigger", "AI", "Report"],
            "next_run_at": a.next_run_at.isoformat() if a.next_run_at else None,
            "last_run_at": a.last_run_at.isoformat() if a.last_run_at else None, "last_status": a.last_status,
            "runs_7d": (stats or {}).get(a.id, 0), "created_at": a.created_at.isoformat(),
            "updated_at": a.updated_at.isoformat()}


def list_agents(db: Session, ctx) -> list[dict]:
    ctx.require(Perm.AI_USE)
    rows = list(db.scalars(select(AiAgent).where(AiAgent.application_id == ctx.application_id)
                           .order_by(AiAgent.created_at.desc())))
    since = utcnow() - timedelta(days=7)
    stats = dict(db.execute(select(AgentRun.agent_id, func.count()).where(
        AgentRun.application_id == ctx.application_id, AgentRun.created_at >= since, AgentRun.dry_run.is_(False))
        .group_by(AgentRun.agent_id)).all()) if rows else {}
    return [out(db, a, stats) for a in rows]


def _audit(db: Session, ctx, action: str, a: AiAgent, meta: dict | None = None) -> None:
    audit_service.record(db, f"ai_agent.{action}", actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type="ai_agent", target_id=a.id, summary=a.name,
                         meta=meta)


def create_agent(db: Session, ctx, cfg: dict) -> AiAgent:
    ctx.require(Perm.AI_MANAGE)
    n = db.scalar(select(func.count()).select_from(AiAgent).where(AiAgent.application_id == ctx.application_id)) or 0
    if n >= MAX_AGENTS:
        raise ValidationFailed(f"An application can have up to {MAX_AGENTS} agents", code="TOO_MANY_AGENTS")
    clean, channels = clean_config(db, ctx, cfg)
    a = AiAgent(organization_id=ctx.organization_id, application_id=ctx.application_id, owner_id=ctx.user.id,
                enabled=False, **clean)
    db.add(a)
    db.flush()
    _set_channels(db, ctx, a, channels)
    _audit(db, ctx, "created", a, {"template": a.template})
    if cfg.get("enabled"):
        set_enabled(db, ctx, a.id, True)
    return a


def update_agent(db: Session, ctx, agent_id: str, changes: dict) -> AiAgent:
    ctx.require(Perm.AI_MANAGE)
    a = get(db, ctx, agent_id)
    merged = {"name": a.name, "description": a.description, "template": a.template, "instructions": a.instructions,
              "trigger": a.trigger, "allowed_tools": a.allowed_tools, "mode": a.mode,
              "destinations": {**(a.destinations or {}), "slack_channels": channels_of(db, a.id)}}
    merged.update({k: v for k, v in changes.items() if k in merged and v is not None})
    clean, channels = clean_config(db, ctx, merged)
    trigger_changed = clean["trigger"] != a.trigger
    for k, v in clean.items():
        setattr(a, k, v)
    _set_channels(db, ctx, a, channels)
    a.owner_id = ctx.user.id  # whoever last edited it vouches for it: it runs with their permissions
    if trigger_changed and a.enabled:
        a.next_run_at = next_run(a, ctx)
        a.event_cursor = utcnow()
    _audit(db, ctx, "updated", a)
    return a


def set_enabled(db: Session, ctx, agent_id: str, enabled: bool) -> AiAgent:
    ctx.require(Perm.AI_MANAGE)
    a = get(db, ctx, agent_id)
    if enabled and not a.enabled:
        clean_config(db, ctx, {"name": a.name, "instructions": a.instructions, "trigger": a.trigger,
                               "allowed_tools": a.allowed_tools, "mode": a.mode,
                               "destinations": {**(a.destinations or {}), "slack_channels": channels_of(db, a.id)}})
        a.enabled, a.owner_id = True, ctx.user.id
        a.next_run_at = next_run(a, ctx)
        a.event_cursor = utcnow()
        _audit(db, ctx, "enabled", a)
    elif not enabled and a.enabled:
        a.enabled, a.next_run_at = False, None
        _audit(db, ctx, "disabled", a)
    return a


def delete_agent(db: Session, ctx, agent_id: str) -> None:
    ctx.require(Perm.AI_MANAGE)
    a = get(db, ctx, agent_id)
    _audit(db, ctx, "deleted", a)
    db.delete(a)

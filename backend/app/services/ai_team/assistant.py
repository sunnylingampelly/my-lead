"""The in-app AI Assistant: per-user conversations per application, streamed answers, read tools that run
straight away and write tools that become confirmation cards (actions.py).

`reply_events` yields (event, data) pairs that the API turns into server-sent events:
  conversation {id, title} → delta {text}… / tool {name, label} / action {card} → done {message, usage}
or error {message}. The user's message is counted against the plan's daily limit before anything else."""
import re

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.core.permissions import Perm
from app.models.ai_team import AiPendingAction, AssistantConversation, AssistantMessage
from app.services.ai_team import actions, guide, llm, metering, prompts, routing, tools, usage
from app.services.ai_team.registry import ToolError
from app.utils.time import utcnow

MAX_TURNS = 6
HISTORY = 20
TITLE_LEN = 60


# ------------------------------------------------------------------ conversations


def conv_out(c: AssistantConversation) -> dict:
    return {"id": c.id, "title": c.title, "message_count": c.message_count, "created_at": c.created_at.isoformat(),
            "updated_at": c.updated_at.isoformat()}


def message_out(m: AssistantMessage) -> dict:
    return {"id": m.id, "role": m.role, "content": m.content, "links": m.links or [],
            "tools": [t for t in (m.tool_calls or []) if t.get("name")], "simulated": m.simulated,
            "charge": ({"amount": float(m.charge_amount), "currency": m.charge_currency}
                       if m.charge_amount is not None else None),
            "model": m.model, "created_at": m.created_at.isoformat()}


def list_conversations(db: Session, ctx, limit: int = 30) -> list[dict]:
    ctx.require(Perm.AI_USE)
    return [conv_out(c) for c in db.scalars(select(AssistantConversation).where(
        AssistantConversation.user_id == ctx.user.id, AssistantConversation.application_id == ctx.application_id)
        .order_by(AssistantConversation.updated_at.desc()).limit(limit))]


def get_conversation(db: Session, ctx, conv_id: str) -> AssistantConversation:
    ctx.require(Perm.AI_USE)
    c = db.get(AssistantConversation, conv_id)
    if c is None or c.user_id != ctx.user.id or c.application_id != ctx.application_id:
        raise NotFound("Conversation not found")
    return c


def conversation_detail(db: Session, ctx, conv_id: str) -> dict:
    c = get_conversation(db, ctx, conv_id)
    msgs = list(db.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == c.id)
                           .order_by(AssistantMessage.created_at, AssistantMessage.id)))
    acts = list(db.scalars(select(AiPendingAction).where(AiPendingAction.conversation_id == c.id)
                           .order_by(AiPendingAction.created_at)))
    return {**conv_out(c), "messages": [message_out(m) for m in msgs], "actions": [actions.card(a) for a in acts]}


def new_conversation(db: Session, ctx) -> AssistantConversation:
    ctx.require(Perm.AI_USE)
    c = AssistantConversation(organization_id=ctx.organization_id, application_id=ctx.application_id,
                              user_id=ctx.user.id, title="New chat")
    db.add(c)
    db.flush()
    return c


def delete_conversation(db: Session, ctx, conv_id: str) -> None:
    c = get_conversation(db, ctx, conv_id)
    db.execute(delete(AiPendingAction).where(AiPendingAction.conversation_id == c.id,
                                             AiPendingAction.status == "pending"))
    db.delete(c)


# ------------------------------------------------------------------ prompt


def page_text(page: dict | None) -> str:
    if not page:
        return "unknown page"
    bits = [str(page.get("path") or "")[:200]]
    for k in ("title", "contact_id", "deal_id", "campaign_id", "form_id", "workflow_id", "bot_id", "agent_id"):
        if page.get(k):
            bits.append(f"{k}={str(page[k])[:60]}")
    return ", ".join(b for b in bits if b)


def instructions(ctx, page: dict | None) -> str:
    app = ctx.application
    return prompts.ASSISTANT.format(user_name=ctx.user.full_name, app_name=app.name, app_id=app.id,
                                    timezone=app.timezone or "UTC", today=utcnow().strftime("%A %d %B %Y"),
                                    safety=prompts.SAFETY, page=page_text(page))


def history_items(db: Session, conv: AssistantConversation) -> list[dict]:
    rows = list(db.scalars(select(AssistantMessage).where(AssistantMessage.conversation_id == conv.id)
                           .order_by(AssistantMessage.created_at.desc(), AssistantMessage.id.desc()).limit(HISTORY)))
    return [{"role": m.role, "content": m.content[:6000]} for m in reversed(rows) if m.content]


# ------------------------------------------------------------------ simulated planner


def _due_days(t: str) -> int:
    if "tomorrow" in t:
        return 1
    if "next week" in t:
        return 7
    m = re.search(r"in (\d+) days?", t)
    return int(m.group(1)) if m else 0 if "today" in t else 1


def _task_from_text(text: str) -> dict:
    t = text.strip()
    m = re.search(r"\b(?:task|remind me)\s+(?:to\s+)?(.+)$", t, re.I)
    what = m.group(1) if m else t
    what = re.sub(r"\b(tomorrow|today|next week|in \d+ days?)\b", "", what, flags=re.I).strip(" .,")
    title = (what[:1].upper() + what[1:])[:200] or "Follow up"
    kind = "call" if re.search(r"\bcall\b", t, re.I) else "email" if re.search(r"\bemail\b", t, re.I) else \
        "meeting" if re.search(r"\bmeet", t, re.I) else "todo"
    who = re.search(r"\b(?:call|email|meet(?:ing)? with|follow up with|ping|text)\s+([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)", t)
    args = {"title": title, "type": kind, "due_in_days": _due_days(t.lower())}
    if who:
        args["contact_query"] = who.group(1)
    return args


def plan(text: str, hint: dict) -> list[tuple[str, dict]]:
    """Deterministic stand-in for the model in simulation mode."""
    t = text.lower().strip()
    page = hint.get("page") or {}
    if guide.never_intent(t):
        return [("platform_help", {"question": text})]
    if re.search(r"\b(create|add|make|set)\b.*\btask\b|\bremind me\b", t):
        return [("create_task", _task_from_text(text))]
    if re.search(r"\b(add|write|create|leave)\b.*\bnote\b", t):
        body = re.split(r":|saying|that says", text, maxsplit=1)[-1].strip() or text
        who = re.search(r"\b(?:to|for|on)\s+([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)", text)
        args = {"body": body[:2000]}
        if page.get("contact_id"):
            args["contact_id"] = page["contact_id"]
        elif page.get("deal_id"):
            args["deal_id"] = page["deal_id"]
        elif who:
            args["contact_query"] = who.group(1)
        return [("create_note", args)]
    if re.search(r"\b(create|make|build|save)\b.*\bsegment\b", t):
        city = re.search(r"\b(?:in|from)\s+([A-Z][a-zA-Z]+)", text)
        cond = {"field": "city", "operator": "is", "value": city.group(1)} if city else \
            {"field": "lead_score", "operator": "gt", "value": 50}
        name = f"Contacts in {city.group(1)}" if city else "High-scoring leads"
        return [("create_segment", {"name": name, "conditions": [cond]})]
    if re.search(r"\b(draft|write|create|prepare)\b.*\b(email|campaign|newsletter)\b", t):
        topic = re.sub(r".*\b(?:about|for|on)\s+", "", text, flags=re.I) if re.search(r"\b(about|for|on)\b", t) \
            else "our latest news"
        return [("create_email_draft", {"name": f"Draft: {topic}"[:160], "subject": topic[:1].upper() + topic[1:255],
                                        "body": f"Hi {{{{first_name}}}},\n\nWe wanted to share {topic}.\n\n"
                                                "Reply to this email if you have any questions.\n\nThanks"})]
    if re.search(r"\b(create|build|make|set up)\b.*\b(workflow|automation|journey)\b", t):
        trigger = "form_submitted" if "form" in t else "chat_lead_captured" if "chat" in t else "contact_created"
        return [("create_workflow_draft", {"name": "Follow up new leads", "trigger": trigger, "steps": [
            {"type": "wait", "amount": 1, "unit": "days"},
            {"type": "create_task", "title": "Follow up with {{name}}", "due_in_hours": 24}]})]
    if re.search(r"\b(create|make|build)\b.*\bform\b", t):
        tpl = next((k for k in ("newsletter", "demo", "event", "callback", "guide") if k in t), "contact")
        return [("create_lead_form", {"name": f"{tpl.capitalize()} form", "template": tpl})]
    if re.search(r"\b(create|set up|build|make)\b.*\bagent\b", t):
        from app.services.ai_team.templates import guess_template

        return [("create_ai_agent", {"template": guess_template(t) or "daily_report"})]
    if "slack" in t and re.search(r"\b(post|send|share|tell)\b", t):
        msg = re.split(r":", text, maxsplit=1)[-1].strip() if ":" in text else "Hello from the Signalcraft AI Assistant"
        ch = re.search(r"#([\w-]+)", text)
        return [("post_to_slack", {"channel": ch.group(1) if ch else "general", "text": msg})]
    if re.search(r"\btag\b", t) and re.search(r"\b(add|tag)\b", t):
        tag = re.search(r"[\"“']([^\"”']+)[\"”']", text)
        who = re.search(r"\b([A-Z][\w'-]+(?:\s[A-Z][\w'-]+)?)\b(?=[^A-Z]*$)", text)
        if tag and who:
            return [("tag_contacts", {"tag": tag.group(1), "contact_query": who.group(1)})]
    if re.search(r"\bmove\b.*\bdeal\b|\bdeal\b.*\bto\b.*\bstage\b", t):
        m = re.search(r"move (?:the )?(.+?) deal to (.+)$", text, re.I)
        if m:
            return [("update_deal_stage", {"deal_query": m.group(1), "stage": m.group(2).strip(" .")})]
    if "stale" in t or "going cold" in t or ("rott" in t and "deal" in t) or "stuck" in t:
        return [("crm_stale_deals", {})]
    if re.search(r"\b(can'?t|cannot|why).*(launch|send)|readiness|ready to send", t):
        name = re.search(r"[\"“']([^\"”']+)[\"”']", text)
        return [("campaign_readiness", {"name": name.group(1)})] if name else [("list_campaigns", {"status": "draft"})]
    if "task" in t:
        due = "overdue" if "overdue" in t else "upcoming" if ("upcoming" in t or "week" in t) else \
            "all" if "all" in t else "today"
        return [("crm_tasks", {"due": due, "assignee": "all" if "team" in t or "everyone" in t else "me"})]
    if re.search(r"\b(deal|pipeline|forecast)s?\b", t):
        return [("crm_deals", {})]
    if re.search(r"\b(balance|wallet|spend|spent|credit|cost)\b", t):
        return [("wallet_summary", {})]
    if re.search(r"\bunanswered|chatbot|chat\b", t):
        return [("chat_summary", {"days": 7})]
    if re.search(r"\bforms?\b", t):
        return [("lead_forms_summary", {})]
    if re.search(r"\b(analytics|performance|kpi|how did we|how are we|report|results|this week|yesterday)\b", t):
        return [("analytics_summary", {"days": 1 if ("today" in t or "yesterday" in t) else 7})]
    if re.search(r"\bcampaigns?\b", t):
        return [("list_campaigns", {})]
    if page.get("contact_id") and re.search(r"\b(this|summar|who is|about)\b", t):
        return [("get_contact", {"contact_id": page["contact_id"]})]
    m = re.search(r"\b(?:find|search|look up|who is|show)\s+(?:contacts?\s+)?(?:named\s+|called\s+)?(.+)$", text, re.I)
    if m or re.search(r"\b(contacts?|leads?)\b", t):
        q = m.group(1).strip(" ?.") if m else None
        if q and q.lower() in ("contacts", "leads", "my leads", "my contacts", "hot leads"):
            q = None
        return [("search_contacts", {"query": q} if q else {"min_lead_score": 50} if "hot" in t else {})]
    if re.search(r"^(how|what|where|can i|help)", t):
        return [("platform_help", {"question": text})]
    return []


# ------------------------------------------------------------------ the reply loop


def _title(text: str) -> str:
    t = " ".join(text.split())
    return (t[:TITLE_LEN - 1] + "…") if len(t) > TITLE_LEN else t or "New chat"


def _links_from(results: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in results:
        for link_ in r.get("links") or []:
            href = link_.get("href") or ""
            if href.startswith("/") and not href.startswith("//") and href not in seen:
                seen.add(href)
                out.append(link_)
    return out[:4]


def start(db: Session, ctx, conv_id: str | None, text: str, page: dict | None) -> tuple[AssistantConversation,
                                                                                       AssistantMessage]:
    """Check the wallet (metered AI must be payable) and the daily fair-use cap, then store the user's message
    (committed before streaming starts)."""
    ctx.require(Perm.AI_USE)
    metering.ensure_can_afford(db, ctx.organization_id)
    usage.consume_or_raise(db, ctx.organization_id, usage.ASSISTANT)
    conv = get_conversation(db, ctx, conv_id) if conv_id else new_conversation(db, ctx)
    if conv.message_count == 0 or conv.title == "New chat":
        conv.title = _title(text)
    m = AssistantMessage(organization_id=ctx.organization_id, application_id=ctx.application_id,
                         conversation_id=conv.id, role="user", content=text.strip()[:4000], context=page or None)
    db.add(m)
    conv.message_count += 1
    conv.updated_at = utcnow()
    db.commit()
    return conv, m


def reply_events(db: Session, ctx, conv: AssistantConversation, page: dict | None):
    yield "conversation", conv_out(conv)
    items = history_items(db, conv)
    specs = tools.specs(ctx)
    system = instructions(ctx, page)
    sim = None if llm.configured() else llm.Simulator(plan, {"page": page or {}})
    if sim:
        yield "meta", {"simulated": True}
    question = next((it["content"] for it in reversed(items) if it.get("role") == "user"), "")
    text, used, results, cards = "", [], [], []
    meter = metering.Meter()
    tokens_in = tokens_out = 0
    proposed, retry_used, retry_next = False, False, False
    for round_idx in range(MAX_TURNS):
        turn = None
        model = routing.assistant_model(question, round_idx, retry=retry_next)
        retry_next = False
        for kind, data in (sim.stream(items) if sim else llm.stream(system, items, specs, model=model)):
            if kind == "delta":
                text += data
                yield "delta", {"text": data}
            else:
                turn = data
        tokens_in += turn.input_tokens
        tokens_out += turn.output_tokens
        meter.add(turn)
        if not turn.tool_calls:
            break
        items += turn.output_items
        errors: list[str] = []
        for call in turn.tool_calls:
            out = _run_call(db, ctx, conv, call, proposed)
            if out.get("code"):
                errors.append(out["code"])
            if out.get("card"):
                proposed = True
                cards.append(out["card"])
                yield "action", out["card"]
            else:
                yield "tool", {"name": call.name, "label": (tools.REGISTRY.get(call.name).label
                                                            if call.name in tools.REGISTRY else call.name),
                               "ok": "error" not in out}
            used.append({"name": call.name, "args": call.arguments, "ok": "error" not in out,
                         "summary": (out.get("summary") or out.get("error") or "")[:500]})
            results.append(out)
            items.append({"type": "function_call_output", "call_id": call.call_id,
                          "output": prompts.untrusted({k: v for k, v in out.items() if k != "card"})})
        db.commit()
        if text and not text.endswith("\n"):
            text += "\n\n"
        # Output that failed validation on the fast model: retry the next round once on the flagship.
        if not sim and not retry_used and model == llm.fast_model() and routing.bad_output(turn, errors):
            retry_used = retry_next = True
    links = _links_from(results)
    msg = AssistantMessage(organization_id=ctx.organization_id, application_id=ctx.application_id,
                           conversation_id=conv.id, role="assistant",
                           content=text.strip() or ("I've prepared that for you below." if cards else "Done."),
                           tool_calls=used or None, links=links or None, simulated=bool(sim),
                           input_tokens=tokens_in, output_tokens=tokens_out,
                           model=",".join(meter.models)[:200] or None, cached_tokens=meter.cached_tokens,
                           cost_usd=meter.cost_usd)
    db.add(msg)
    db.flush()
    charged = metering.charge(db, ctx.organization_id, ctx.application_id, meter, key=f"ai:msg:{msg.id}",
                              description="AI Assistant", reference_type="ai_message", reference_id=msg.id,
                              meta={"conversation_id": conv.id, "user_id": ctx.user.id})
    if charged:
        msg.charge_amount, msg.charge_currency = charged["amount"], charged["currency"]
    conv.message_count += 1
    conv.updated_at = utcnow()
    db.commit()
    yield "done", {"message": message_out(msg), "usage": usage.summary(db, ctx.organization_id)}


def _run_call(db: Session, ctx, conv: AssistantConversation, call: llm.ToolCall, proposed: bool) -> dict:
    if call.invalid:
        return {"error": "The arguments weren't valid JSON", "code": "INVALID_ARGUMENTS"}
    try:
        tool = tools.get(call.name)
        if tool.kind == "read":
            return tools.run_read(db, ctx, call.name, call.arguments)
        if proposed:
            return {"error": "One change at a time: ask the person to confirm the card above first."}
        prepared = tools.prepare(db, ctx, call.name, call.arguments)
        a = actions.propose(db, ctx, call.name, prepared, source="assistant", conversation_id=conv.id)
        return {"summary": f"I've prepared **{prepared.title}**. Review it below, then confirm, edit or cancel.",
                "status": "awaiting_confirmation", "action_id": a.id, "card": actions.card(a)}
    except ToolError as exc:
        out = {"error": exc.message, "code": exc.code}
        if exc.code == "NEVER_AVAILABLE":
            out["summary"] = exc.message
        if exc.link:
            out["links"] = [exc.link]
        return out

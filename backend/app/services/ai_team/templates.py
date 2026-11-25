"""Ready-to-switch-on AI agent templates, and the deterministic plan each one follows in simulation mode (no
OpenAI key): the same tools the model would call, in order, so the run log, approvals and Slack posts can be
tried offline."""
from sqlalchemy.orm import Session

from app.models import Contact

EVENTS = {
    "form_submitted": "A lead form is submitted",
    "chat_lead_captured": "The chatbot captures a lead",
    "chat_conversation_closed": "A chat conversation ends",
    "ai_call_completed": "An AI call is completed",
    "deal_stage_changed": "A deal changes stage",
    "deal_rotting": "A deal is going cold",
    "contact_created": "A contact is created",
    "campaign_completed": "A campaign finishes sending",
    "low_balance": "The wallet balance is low",
    "score_reached": "A lead becomes hot (lead score)",
}
# Filters each event understands (also used to validate an agent's trigger).
EVENT_FILTERS = {
    "form_submitted": ("form_id",), "chat_lead_captured": ("bot_id",), "chat_conversation_closed": ("bot_id",),
    "ai_call_completed": ("interest",), "deal_stage_changed": ("pipeline_id", "stage_id"),
    "deal_rotting": ("pipeline_id",), "contact_created": (), "campaign_completed": ("failed_only",),
    "low_balance": (), "score_reached": (),
}

TEMPLATES: dict[str, dict] = {
    "lead_qualifier": {
        "name": "Lead qualifier", "icon": "user-check",
        "description": "Researches every new lead's company, scores the fit, writes a summary note, assigns an owner "
                       "and posts to Slack.",
        "trigger": {"type": "event", "events": ["form_submitted", "chat_lead_captured"], "filters": {}},
        "allowed_tools": ["get_contact", "research_company", "list_team", "record_lead_assessment", "assign_owner"],
        "mode": "auto", "open": {"label": "Open lead", "path": "/audience/contacts/{contact_id}"},
        "flow": ["New lead", "Research & score", "Note + owner", "Slack"],
        "instructions": "A new lead just came in. Look up the contact, read their company's website (from their work "
                        "email domain or website) and judge how well they fit our ideal customer: a business that "
                        "would buy what we sell, with a real company, a work email and a clear need. Record a fit "
                        "score from 0 to 100 with a two-sentence summary of who they are and why. If the lead has "
                        "no owner, assign one (round-robin is fine: pick the teammate with the fewest new leads, or "
                        "the agent's owner). Finish with a three-line summary for the sales team.",
    },
    "hot_lead_alert": {
        "name": "Hot-lead alert", "icon": "flame",
        "description": "When an AI call ends with a hot lead (or a lead's score turns hot), alerts Slack and creates a "
                       "call-back task.",
        "trigger": {"type": "event", "events": ["ai_call_completed", "score_reached"], "filters": {"interest": "hot"}},
        "allowed_tools": ["get_contact", "create_task"],
        "mode": "auto", "open": {"label": "Open lead", "path": "/audience/contacts/{contact_id}"},
        "flow": ["Hot lead", "Create task", "Slack"],
        "instructions": "A lead just turned hot. Look up the contact and create a high-priority call task due today "
                        "for their owner, titled “Call back <name> (hot lead)”. Summarise in two lines why they're "
                        "hot (call summary or score) so whoever picks it up has context.",
    },
    "stale_deal_watchdog": {
        "name": "Stale-deal watchdog", "icon": "hourglass",
        "description": "Every morning at 10:00, lists the deals going cold per owner and posts them to Slack.",
        "trigger": {"type": "schedule", "every": "daily", "time": "10:00"},
        "allowed_tools": ["crm_stale_deals"],
        "mode": "auto", "open": {"label": "Open deals", "path": "/crm/deals"},
        "flow": ["Daily 10:00", "Find stale deals", "Slack"],
        "instructions": "List the open deals that are going cold, grouped by owner, with how long each has been "
                        "stuck. Suggest one concrete next step per owner. If none are stale, say so in one line.",
    },
    "daily_report": {
        "name": "Daily performance report", "icon": "bar-chart",
        "description": "Every morning, yesterday's cross-channel KPIs compared with the day before, posted to Slack.",
        "trigger": {"type": "schedule", "every": "daily", "time": "09:00"},
        "allowed_tools": ["analytics_summary"],
        "mode": "auto", "open": {"label": "Open analytics", "path": "/analytics"},
        "flow": ["Daily 09:00", "Analytics", "Slack"],
        "instructions": "Report yesterday's results across email, calls, lead forms and chat compared with the day "
                        "before (use a 1-day range). Lead with the two biggest changes, then a compact list of KPIs. "
                        "Keep it under 12 lines.",
    },
    "weekly_campaign_report": {
        "name": "Weekly campaign report", "icon": "calendar",
        "description": "Every Monday at 09:00, last week's campaigns and how they performed.",
        "trigger": {"type": "schedule", "every": "weekly", "day": 0, "time": "09:00"},
        "allowed_tools": ["list_campaigns", "analytics_summary"],
        "mode": "auto", "open": {"label": "Open campaigns", "path": "/email/campaigns"},
        "flow": ["Mondays 09:00", "Campaigns + KPIs", "Slack"],
        "instructions": "Summarise the last 7 days of campaigns: what was sent, open and click rates, the best and "
                        "worst performer, and one recommendation for this week.",
    },
    "chat_followup": {
        "name": "Chat follow-up drafter", "icon": "mail",
        "description": "When a chat with a lead ends, drafts a personal follow-up email for you to approve.",
        "trigger": {"type": "event", "events": ["chat_conversation_closed"], "filters": {}},
        "allowed_tools": ["get_contact", "create_email_draft"],
        "mode": "approve", "open": {"label": "Open lead", "path": "/audience/contacts/{contact_id}"},
        "flow": ["Chat ends", "Draft email", "Approval"],
        "instructions": "A website chat with a lead just ended. Look up the contact (the chat summary is in their "
                        "timeline) and draft a short, friendly follow-up email to them that answers what they asked "
                        "and proposes one next step. Create it as a draft addressed to that contact only.",
    },
    "balance_alert": {
        "name": "Low-balance & failed-campaign alert", "icon": "alert",
        "description": "Alerts the team when the wallet runs low or a campaign finishes with many failures.",
        "trigger": {"type": "event", "events": ["low_balance", "campaign_completed"], "filters": {"failed_only": True}},
        "allowed_tools": ["wallet_summary", "list_campaigns"],
        "mode": "auto", "open": {"label": "Open billing", "path": "billing"},
        "flow": ["Low balance / failures", "Check", "Slack"],
        "instructions": "Explain the problem in two lines (balance and this month's spend, or the campaign and its "
                        "failure numbers) and what to do next (top up, or check the sender and audience).",
    },
    "unanswered_digest": {
        "name": "Unanswered-questions digest", "icon": "help",
        "description": "Every afternoon, the questions your chatbot couldn't answer, with an “Answer now” button.",
        "trigger": {"type": "schedule", "every": "daily", "time": "17:00"},
        "allowed_tools": ["chat_summary"],
        "mode": "auto", "open": {"label": "Answer now", "path": "/chat"},
        "flow": ["Daily 17:00", "Unanswered questions", "Slack"],
        "instructions": "List the questions visitors asked today that the chatbot couldn't answer, most frequent "
                        "first, so the team can teach it. If there are none, say so in one line.",
    },
}


def listing() -> list[dict]:
    return [{"key": k, "name": t["name"], "description": t["description"], "icon": t["icon"], "flow": t["flow"],
             "trigger": t["trigger"], "mode": t["mode"], "allowed_tools": t["allowed_tools"],
             "instructions": t["instructions"]}
            for k, t in TEMPLATES.items()]


def _sim_score(c: Contact | None) -> int:
    if c is None:
        return 40
    score = 30
    if c.email and "@" in c.email and c.email.split("@")[-1].lower() not in (
            "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"):
        score += 30
    if c.phone:
        score += 10
    if c.company:
        score += 15
    if (c.lead_score or 0) >= 50:
        score += 10
    return min(score, 100)


def simulated_plan(db: Session, agent, trigger: dict) -> list[tuple[str, dict]]:
    """The tool calls a template makes in simulation, restricted to the agent's allowed tools."""
    key, cid, kind = agent.template, trigger.get("contact_id"), trigger.get("event")
    contact = db.get(Contact, cid) if cid else None
    name = (contact.full_name or contact.email or "the lead") if contact else "the lead"
    plan: list[tuple[str, dict]] = []
    if key == "lead_qualifier" and contact:
        score = _sim_score(contact)
        plan = [("get_contact", {"contact_id": cid}), ("research_company", {"contact_id": cid}),
                ("record_lead_assessment", {"contact_id": cid, "score": score,
                                            "summary": f"{name}{' from ' + contact.company if contact.company else ''} "
                                                       f"came in via {kind or 'a form'}. Simulated fit score {score}/100 "
                                                       "from the contact's details (work email, phone, company)."})]
        if not contact.owner_id:
            plan.append(("assign_owner", {"contact_id": cid, "owner": agent.owner_id or "me"}))
    elif key == "hot_lead_alert" and contact:
        plan = [("get_contact", {"contact_id": cid}),
                ("create_task", {"title": f"Call back {name} (hot lead)", "type": "call", "priority": "high",
                                 "due_in_days": 0, "contact_id": cid})]
    elif key == "stale_deal_watchdog":
        plan = [("crm_stale_deals", {})]
    elif key == "daily_report":
        plan = [("analytics_summary", {"days": 1})]
    elif key == "weekly_campaign_report":
        plan = [("list_campaigns", {"limit": 10}), ("analytics_summary", {"days": 7})]
    elif key == "chat_followup" and contact:
        first = contact.first_name or "there"
        plan = [("get_contact", {"contact_id": cid}),
                ("create_email_draft", {"name": f"Follow-up: {name}"[:160], "subject": "Thanks for chatting with us",
                                        "body": f"Hi {first},\n\nThanks for chatting with us today. As promised, here "
                                                "is a quick follow-up. Would you like to book a short call this week "
                                                "to go over the details?\n\nBest regards",
                                        "contact_ids": [cid]})]
    elif key == "balance_alert":
        plan = [("wallet_summary", {})] if kind == "low_balance" else [("list_campaigns", {"limit": 5})]
    elif key == "unanswered_digest":
        plan = [("chat_summary", {"days": 1})]
    else:
        # A custom agent in simulation: use its first two read tools.
        from app.services.ai_team.registry import REGISTRY

        reads = [t for t in agent.allowed_tools if t in REGISTRY and REGISTRY[t].kind == "read"
                 and not REGISTRY[t].parameters.get("required")]
        plan = [(t, {}) for t in reads[:2]]
    return [(t, a) for t, a in plan if t in (agent.allowed_tools or [])]


def guess_template(text: str) -> str | None:
    """Simulation mode's "Describe what you want": pick the closest template."""
    t = text.lower()
    rules = [("unanswered_digest", ("unanswered", "couldn't answer", "chatbot question")),
             ("stale_deal_watchdog", ("stale", "rotting", "going cold", "stuck deal")),
             ("weekly_campaign_report", ("weekly", "campaign report")),
             ("daily_report", ("daily", "report", "kpi", "performance")),
             ("hot_lead_alert", ("hot lead", "hot", "alert me when")),
             ("chat_followup", ("follow-up", "follow up", "chat")),
             ("balance_alert", ("balance", "wallet", "failed campaign")),
             ("lead_qualifier", ("qualify", "score", "research", "new lead", "lead"))]
    for key, words in rules:
        if any(w in t for w in words):
            return key
    return None

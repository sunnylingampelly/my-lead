"""A short built-in product guide the assistant answers how-to questions from (platform_help), and the actions
the AI is never allowed to take, with how people do them themselves."""
import re

# (topic, keywords, answer, path under /apps/{id})
GUIDE: list[tuple[str, tuple[str, ...], str, str]] = [
    ("Import contacts", ("import", "csv", "excel", "upload contacts"),
     "Go to **Audience → Import**, upload a CSV or Excel file, map the columns to contact fields, choose the consent "
     "basis and start the import. Duplicates are matched by the application's identity rule (email and/or phone).",
     "/audience/import"),
    ("Segments", ("segment", "filter contacts", "audience rule"),
     "Segments are saved filters that stay up to date. Open **Audience → Segments → New segment**, add conditions "
     "(field, operator, value), check the live preview count and save. Use segments as campaign audiences or "
     "workflow triggers.", "/audience/segments"),
    ("Email campaigns", ("email campaign", "newsletter", "send email", "campaign"),
     "Create a campaign in **Email → Campaigns → New campaign**: pick a verified sender, write the subject and content "
     "(visual, HTML or plain text), choose the audience and check readiness. Then send now or schedule it. Sending "
     "is always done by you, never by the AI.", "/email/campaigns"),
    ("Sender verification", ("sender", "verify", "domain", "spf", "dkim", "dmarc"),
     "Add a sender in **Email → Senders**, confirm the email we send to it, then add the SPF, DKIM and DMARC records "
     "shown on the senders page to your domain's DNS for the best deliverability.", "/email/senders"),
    ("Voice and AI calls", ("voice", "call", "ai agent call", "calling"),
     "Voice campaigns play a recording or text-to-speech message; AI calling agents hold a conversation and log the "
     "outcome (interest, summary) to the contact. Set them up under **Voice**.", "/voice"),
    ("CRM pipeline", ("deal", "pipeline", "stage", "crm", "rotting", "stale"),
     "Deals live on the board in **CRM → Deals**. Drag a deal to change its stage. Stages can rot after a number of "
     "days without activity (set it in CRM settings), and rotting deals are highlighted.", "/crm/deals"),
    ("Tasks", ("task", "follow up", "reminder"),
     "Tasks are in **CRM → Tasks**. Create them from a contact or deal, assign an owner and a due time; owners get a "
     "reminder when a task is due.", "/crm/tasks"),
    ("Automation", ("workflow", "automation", "journey", "trigger"),
     "Build journeys in **Automation**: choose a trigger (contact created, form submitted, deal stage changed…), "
     "add steps (email, wait, condition, CRM action, AI step, Send to Slack) and publish. Use “Test” to dry-run a "
     "contact through it first.", "/automation"),
    ("Lead forms", ("form", "lead form", "embed"),
     "Create a form in **Lead forms** from a template, adjust fields and design, publish it and embed it with the "
     "snippet on the Share tab. Submissions create or update contacts.", "/forms"),
    ("Website chatbot", ("chatbot", "chat widget", "live chat", "unanswered"),
     "Create a bot in **Chat → Chatbots**, train it on your website, FAQs or files, and add the widget snippet to "
     "your site. Questions it couldn't answer show up in Chat analytics so you can teach it.", "/chat/bots"),
    ("Wallet and billing", ("wallet", "balance", "top up", "credit", "billing", "plan", "upgrade"),
     "Usage (email, voice minutes, AI chat replies) is paid from the organization's prepaid wallet. Owners top up "
     "and change plans on the organization's **Billing** page.", ""),
    ("Team and roles", ("role", "permission", "invite", "team member"),
     "Owners and admins invite people and change roles on the organization's **Team** page.", ""),
    ("AI agents", ("agent", "ai team", "slack", "approval"),
     "AI agents work on their own: pick a template or describe what you want under **AI Team → AI Agents**, choose "
     "what starts it (an event or a schedule), what it may do, and where it reports (in-app, email, Slack). In "
     "approval mode its actions wait in **Approvals** (and in Slack) until someone approves them.", "/ai/agents"),
]

# Things the AI never does, whatever it is asked: (patterns, explanation, path or org page)
NEVER: dict[str, tuple[str, str]] = {
    "send_campaign": ("Sending, launching or scheduling campaigns is always done by you: open the campaign, check "
                      "readiness and press Send or Schedule.", "/email/campaigns"),
    "delete_data": ("I can't delete anything. You can delete records yourself from their page (contacts, deals, "
                    "segments, campaigns…).", "/audience/contacts"),
    "billing": ("I can't top up the wallet or change the plan. Owners can do that on the organization's Billing "
                "page.", "billing"),
    "roles": ("I can't change roles or permissions. Owners and admins manage them on the organization's Team page.",
              "team"),
    "erase_contact": ("I can't erase contacts. Data-subject erasure is done from the contact's profile → Privacy by "
                      "someone with the privacy permission.", "/audience/contacts"),
}
NEVER_TOOL_NAMES = {"send_campaign": "send_campaign", "launch_campaign": "send_campaign",
                    "schedule_campaign": "send_campaign", "send_email": "send_campaign",
                    "delete_contact": "delete_data", "delete_contacts": "delete_data", "delete_deal": "delete_data",
                    "delete": "delete_data", "erase_contact": "erase_contact", "top_up_wallet": "billing",
                    "change_plan": "billing", "change_role": "roles", "update_permissions": "roles"}
_NEVER_PATTERNS = [
    ("send_campaign", r"\b(send|launch|schedule|blast)\b.*\b(campaign|newsletter|email|blast)s?\b"),
    ("erase_contact", r"\b(erase|forget|gdpr)\b"),
    ("delete_data", r"\b(delete|remove|wipe|purge)\b"),
    ("billing", r"\b(top ?up|add (credit|money|funds)|recharge|upgrade|downgrade|change (my )?plan)\b"),
    ("roles", r"\b(make|change|promote|demote)\b.*\b(admin|owner|role|permission)s?\b"),
]


def never_intent(text: str) -> str | None:
    t = text.lower()
    for key, pat in _NEVER_PATTERNS:
        if re.search(pat, t):
            return key
    return None


def help_for(question: str) -> list[tuple[str, str, str]]:
    q = question.lower()
    scored = []
    for topic, keys, answer, path in GUIDE:
        score = sum(2 if k in q else 0 for k in keys) + sum(1 for w in topic.lower().split() if w in q)
        if score:
            scored.append((score, topic, answer, path))
    scored.sort(key=lambda s: -s[0])
    return [(t, a, p) for _, t, a, p in scored[:2]]

"""Starter templates for new lead forms. Each returns a full, valid draft definition."""
from app.schemas.forms import FormDefinition


def _f(id_, type_, label, *, required=False, width="full", placeholder="", step=0, **extra) -> dict:
    d = {"id": id_, "type": type_, "label": label, "required": required, "width": width,
         "placeholder": placeholder, "step": step}
    if type_ in ("first_name", "last_name", "email", "phone"):
        d["map_to"] = {"kind": "standard", "key": type_}
    d.update(extra)
    return d


def _opts(*labels) -> list[dict]:
    return [{"label": x, "value": x} for x in labels]


NAME = [_f("first_name", "first_name", "First name", required=True, width="half"),
        _f("last_name", "last_name", "Last name", width="half")]
CONSENT = _f("consent", "consent", "I agree to receive marketing emails. I can unsubscribe at any time.",
             consent_channels=["email"])

TEMPLATES: dict[str, dict] = {
    "newsletter": {
        "name": "Newsletter signup", "description": "Grow your email list with a short subscribe form.",
        "def": {"title": "Subscribe to our newsletter",
                "description": "Tips, news and offers. No spam, unsubscribe any time.",
                "fields": [_f("first_name", "first_name", "First name"),
                           _f("email", "email", "Email", required=True, placeholder="you@example.com")],
                "design": {"button_text": "Subscribe"},
                "success": {"message_html": "<p><strong>You're subscribed!</strong> Check your inbox.</p>"},
                "display": {"mode": "popup", "trigger": "scroll", "scroll_percent": 40},
                "settings": {"subscribe_on_submit": ["email"], "source": "Newsletter form",
                             "consent_text": "By subscribing you agree to receive our emails. "
                                             "You can unsubscribe at any time.",
                             "double_opt_in": False, "create_deal": False}},
    },
    "contact": {
        "name": "Contact us", "description": "Name, email, phone and a message. Goes straight to your CRM.",
        "def": {"title": "Contact us", "description": "Send us a message and we'll get back to you within a day.",
                "fields": [*NAME, _f("email", "email", "Email", required=True, placeholder="you@example.com"),
                           _f("phone", "phone", "Phone"),
                           _f("message", "textarea", "How can we help?", required=True,
                              map_to={"kind": "none", "key": ""}),
                           CONSENT],
                "design": {"button_text": "Send message"},
                "settings": {"source": "Contact form"}},
    },
    "demo": {
        "name": "Request a demo / quote", "description": "Qualify leads and open a deal in your pipeline.",
        "def": {"title": "Request a demo", "description": "Tell us a little about your team.",
                "fields": [*NAME, _f("email", "email", "Work email", required=True),
                           _f("phone", "phone", "Phone", required=True),
                           _f("company", "text", "Company", required=True, width="half",
                              map_to={"kind": "standard", "key": "company"}),
                           _f("team_size", "select", "Team size", width="half",
                              options=_opts("1-10", "11-50", "51-200", "201-1000", "1000+")),
                           _f("notes", "textarea", "What would you like to see?")],
                "design": {"button_text": "Request demo"},
                "settings": {"source": "Demo request", "create_deal": True, "deal_title": "Demo: {name}"}},
    },
    "event": {
        "name": "Event registration", "description": "Two-step registration for a webinar or event.",
        "def": {"title": "Register for the event",
                "steps": [{"id": "step_1", "title": "Your details"}, {"id": "step_2", "title": "Preferences"}],
                "fields": [*NAME, _f("email", "email", "Email", required=True),
                           _f("phone", "phone", "Phone"),
                           _f("attendance", "radio", "How will you attend?", required=True, step=1,
                              options=_opts("In person", "Online")),
                           _f("sessions", "checkboxes", "Sessions you're interested in", step=1,
                              options=_opts("Keynote", "Workshops", "Networking"),
                              map_to={"kind": "tag", "key": ""}),
                           _f("dietary", "text", "Dietary requirements", step=1,
                              condition={"field": "attendance", "op": "equals", "value": "In person"}),
                           CONSENT],
                "design": {"button_text": "Register"},
                "settings": {"source": "Event registration"}},
    },
    "guide": {
        "name": "Download a guide", "description": "Lead magnet: collect an email, then send them to the download.",
        "def": {"title": "Get the free guide", "description": "Enter your email and we'll take you to the download.",
                "fields": [_f("first_name", "first_name", "First name"),
                           _f("email", "email", "Email", required=True)],
                "design": {"button_text": "Download now"},
                "success": {"mode": "both", "redirect_url": "https://example.com/guide.pdf", "redirect_delay": 2,
                            "message_html": "<p><strong>Thanks!</strong> Your download is starting…</p>"},
                "settings": {"subscribe_on_submit": ["email"], "source": "Guide download",
                             "consent_text": "We'll also send you occasional emails. Unsubscribe any time."}},
    },
    "callback": {
        "name": "Callback request", "description": "Let visitors ask for a call at a time that suits them.",
        "def": {"title": "Request a callback", "description": "Leave your number and we'll call you back.",
                "fields": [_f("first_name", "first_name", "Name", required=True),
                           _f("phone", "phone", "Phone", required=True),
                           _f("best_time", "select", "Best time to call", required=True,
                              options=_opts("Morning", "Afternoon", "Evening")),
                           _f("consent", "consent", "I agree to be contacted by phone about my request.",
                              required=True, consent_channels=["voice"])],
                "design": {"button_text": "Call me back"},
                "display": {"mode": "floating", "button_label": "Request a call"},
                "settings": {"source": "Callback request"}},
    },
    "blank": {
        "name": "Blank form", "description": "Start from an email field and build your own.",
        "def": {"title": "", "fields": [_f("email", "email", "Email", required=True)]},
    },
}


def definition(key: str | None) -> dict:
    t = TEMPLATES.get(key or "blank") or TEMPLATES["blank"]
    return FormDefinition.model_validate(t["def"]).model_dump()


def listing() -> list[dict]:
    return [{"key": k, "name": t["name"], "description": t["description"]} for k, t in TEMPLATES.items()]

"""Website chatbots and live chat: bot settings, training sources, inbox actions and public widget calls."""
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
LEAD_FIELD_KEYS = ("name", "email", "phone", "company")


class Appearance(BaseModel):
    model_config = ConfigDict(extra="ignore")

    color: str = "#4f46e5"
    position: Literal["left", "right"] = "right"
    offset_x: int = Field(20, ge=0, le=200)
    offset_y: int = Field(20, ge=0, le=300)
    launcher_icon: Literal["chat", "help", "sparkles", "wave"] = "chat"
    launcher_text: str = Field("", max_length=40)
    title: str = Field("", max_length=60)
    subtitle: str = Field("We usually reply in a few minutes", max_length=120)
    theme: Literal["light", "dark", "auto"] = "light"
    show_on_mobile: bool = True
    mobile_fullscreen: bool = True
    sound: bool = True
    show_branding: bool = True  # "Powered by Signalcraft"; always hidden on Pro

    @field_validator("color")
    @classmethod
    def _color(cls, v: str) -> str:
        if not HEX.match(v or ""):
            raise ValueError("Use a hex colour like #4f46e5")
        return v.lower()


class LeadField(BaseModel):
    key: str = Field(..., max_length=40)
    label: str = Field(..., min_length=1, max_length=60)
    required: bool = False

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        if v not in LEAD_FIELD_KEYS and not re.match(r"^attr:[a-z0-9_]{1,40}$", v):
            raise ValueError("Field must be name, email, phone, company or attr:<custom field key>")
        return v


class LeadConsent(BaseModel):
    enabled: bool = True
    text: str = Field("Email me news and offers. I can unsubscribe at any time.", max_length=300)
    channels: list[Literal["email", "sms"]] = ["email"]


class LeadCapture(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mode: Literal["before", "after", "when_needed", "off"] = "when_needed"
    after_messages: int = Field(2, ge=1, le=20)
    prompt: str = Field("Could you share your details so our team can follow up?", max_length=300)
    fields: list[LeadField] = Field(default_factory=lambda: [
        LeadField(key="name", label="Name", required=True), LeadField(key="email", label="Email", required=True),
        LeadField(key="phone", label="Phone", required=False)], max_length=8)
    consent: LeadConsent = Field(default_factory=LeadConsent)

    @field_validator("fields")
    @classmethod
    def _fields(cls, v: list[LeadField]) -> list[LeadField]:
        keys = [f.key for f in v]
        if len(set(keys)) != len(keys):
            raise ValueError("Each field can only be asked once")
        if v and not ({"email", "phone"} & set(keys)):
            raise ValueError("Ask for an email or a phone number so the lead can become a contact")
        return v


class BusinessHours(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = False
    timezone: str = Field("UTC", max_length=64)
    days: dict[str, list[str] | None] = Field(default_factory=lambda: {
        d: (["09:00", "18:00"] if d not in ("sat", "sun") else None) for d in DAYS})

    @field_validator("days")
    @classmethod
    def _days(cls, v: dict) -> dict:
        out = {}
        for d in DAYS:
            span = v.get(d)
            if span:
                if len(span) != 2 or not all(TIME.match(t or "") for t in span) or span[0] >= span[1]:
                    raise ValueError(f"Opening hours for {d} must be HH:MM–HH:MM with the start first")
                out[d] = list(span)
            else:
                out[d] = None
        return out


class Proactive(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = False
    delay_seconds: int = Field(15, ge=0, le=600)
    message: str = Field("Hi there! Have a question? I'm here to help.", max_length=300)
    paths: list[str] = Field(default_factory=list, max_length=20)  # only on these URL paths (prefix, * allowed)


class BotCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    template: str | None = Field(None, max_length=40)


class BotUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    avatar_url: str | None = Field(None, max_length=500)
    instructions: str | None = Field(None, max_length=20_000)
    welcome_message: str | None = Field(None, max_length=1000)
    quick_replies: list[str] | None = Field(None, max_length=6)
    language: str | None = Field(None, max_length=10)
    fallback: Literal["human", "collect"] | None = None
    lead_capture: LeadCapture | None = None
    business_hours: BusinessHours | None = None
    allowed_domains: list[str] | None = Field(None, max_length=50)
    appearance: Appearance | None = None
    proactive: Proactive | None = None
    routing: Literal["broadcast", "round_robin"] | None = None

    @field_validator("quick_replies")
    @classmethod
    def _chips(cls, v):
        if v is None:
            return v
        out = [c.strip()[:60] for c in v if c and c.strip()]
        return list(dict.fromkeys(out))

    @field_validator("avatar_url")
    @classmethod
    def _avatar(cls, v):
        if v and not re.match(r"^https://[^\s\"'<>]+$", v.strip()):
            raise ValueError("Use an https:// image address")
        return v.strip() if v else None

    @field_validator("language")
    @classmethod
    def _lang(cls, v):
        if v is not None and v != "auto" and not re.match(r"^[a-z]{2}(-[A-Z]{2})?$", v):
            raise ValueError("Use 'auto' or a language code like en or hi")
        return v


# ------------------------------------------------------------------ training


class SourceCreate(BaseModel):
    kind: Literal["text", "faq", "url"]
    title: str | None = Field(None, max_length=300)
    content: str | None = Field(None, max_length=500_000)  # text, or the FAQ answer
    question: str | None = Field(None, max_length=2000)
    url: str | None = Field(None, max_length=2000)
    crawl: bool = False
    max_pages: int = Field(10, ge=1, le=50)


class SourceUpdate(BaseModel):
    title: str | None = Field(None, max_length=300)
    content: str | None = Field(None, max_length=500_000)
    question: str | None = Field(None, max_length=2000)


class ImproveAnswer(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    answer: str = Field(..., min_length=1, max_length=10_000)
    message_id: str | None = Field(None, max_length=36)


class TestMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., max_length=4000)


class BotTest(BaseModel):
    messages: list[TestMessage] = Field(..., min_length=1, max_length=40)


# ------------------------------------------------------------------ inbox


class AgentReply(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    internal: bool = False


class AssignBody(BaseModel):
    user_id: str | None = Field(None, max_length=36)


class TagsBody(BaseModel):
    tags: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("tags")
    @classmethod
    def _tags(cls, v):
        return list(dict.fromkeys(t.strip()[:40] for t in v if t and t.strip()))


class PresenceBody(BaseModel):
    status: Literal["online", "away", "offline"] = "online"


class CannedIn(BaseModel):
    shortcut: str = Field(..., min_length=1, max_length=40)
    title: str = Field(..., min_length=1, max_length=120)
    body: str = Field(..., min_length=1, max_length=4000)

    @field_validator("shortcut")
    @classmethod
    def _shortcut(cls, v: str) -> str:
        v = v.strip().lstrip("/").lower()
        if not re.match(r"^[a-z0-9][a-z0-9_-]{0,38}$", v):
            raise ValueError("Use letters, numbers, - or _ (for example hello)")
        return v


class AgentAdd(BaseModel):
    user_id: str = Field(..., max_length=36)


# ------------------------------------------------------------------ public widget


class PageInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    url: str | None = Field(None, max_length=2000)
    title: str | None = Field(None, max_length=300)
    referrer: str | None = Field(None, max_length=1000)
    host: str | None = Field(None, max_length=300)  # the embedding website's origin


class VisitorIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    page: PageInfo | None = None
    name: str | None = Field(None, max_length=200)
    email: str | None = Field(None, max_length=320)
    phone: str | None = Field(None, max_length=40)
    attributes: dict[str, str | int | float | bool | None] | None = None

    @field_validator("attributes")
    @classmethod
    def _attrs(cls, v):
        if v is None:
            return v
        out = {}
        for k, val in list(v.items())[:30]:
            if re.match(r"^[A-Za-z0-9_.-]{1,40}$", k):
                out[k] = val if not isinstance(val, str) else val[:300]
        return out


class VisitorMessage(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    stream: bool = False
    host: str | None = Field(None, max_length=300)


class LeadIn(BaseModel):
    values: dict[str, str] = Field(default_factory=dict)
    consent: bool = False
    host: str | None = Field(None, max_length=300)

    @field_validator("values")
    @classmethod
    def _values(cls, v):
        return {k[:50]: (str(val) or "")[:300] for k, val in list(v.items())[:12]}


class OfflineIn(BaseModel):
    name: str | None = Field(None, max_length=200)
    email: str = Field(..., min_length=3, max_length=320)
    phone: str | None = Field(None, max_length=40)
    message: str = Field(..., min_length=1, max_length=4000)
    consent: bool = False
    host: str | None = Field(None, max_length=300)


class RatingIn(BaseModel):
    rating: Literal["up", "down"]
    comment: str | None = Field(None, max_length=1000)


class TranscriptIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=320)


class HostIn(BaseModel):
    host: str | None = Field(None, max_length=300)

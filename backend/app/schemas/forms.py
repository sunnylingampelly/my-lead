"""Lead form definitions and API shapes.

A form definition is one JSON document (stored as the draft, and snapshotted on publish):
    {title, description, fields[], steps[], design{}, success{}, display{}, settings{}}
Every value is bounded here, so a definition that passes validation is safe to store and render.
"""
from datetime import date, datetime
from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

FIELD_TYPES = ("first_name", "last_name", "email", "phone", "text", "textarea", "number", "select", "radio",
               "checkboxes", "date", "consent", "hidden")
FieldType = Literal["first_name", "last_name", "email", "phone", "text", "textarea", "number", "select", "radio",
                    "checkboxes", "date", "consent", "hidden"]
# Contact standard fields a form field can map to.
STANDARD_FIELDS = ("first_name", "last_name", "email", "phone", "company", "city", "state", "country",
                   "postal_code")
FONTS = ("system", "Inter", "Roboto", "Open Sans", "Lato", "Poppins", "Montserrat", "Nunito", "Source Sans 3",
         "Merriweather", "Playfair Display")
HEX = r"^#[0-9a-fA-F]{6}$"
ID = r"^[a-z0-9_]{1,40}$"
Channel = Literal["email", "sms", "voice"]


def http_url(v: str | None, what: str = "URL") -> str | None:
    """Only absolute http(s) URLs (no javascript:, data:, protocol-relative or relative URLs)."""
    v = (v or "").strip()
    if not v:
        return None
    p = urlparse(v)
    if p.scheme not in ("http", "https") or not p.netloc or any(c in v for c in "\r\n\t <>\"'"):
        raise ValueError(f"{what} must start with http:// or https://")
    return v


class Strict(BaseModel):
    model_config = ConfigDict(extra="ignore")


class FieldOption(Strict):
    label: str = Field(min_length=1, max_length=200)
    value: str = Field("", max_length=200)

    @model_validator(mode="after")
    def _value(self):
        if not self.value:
            self.value = self.label
        return self


class FieldCondition(Strict):
    """Show this field only when another field's value matches."""
    field: str = Field(pattern=ID)
    op: Literal["equals", "not_equals", "contains", "is_set", "is_not_set"] = "equals"
    value: str = Field("", max_length=200)


class HiddenSource(Strict):
    kind: Literal["fixed", "url_param", "page_url", "referrer", "utm_source", "utm_medium", "utm_campaign",
                  "utm_term", "utm_content"] = "fixed"
    value: str = Field("", max_length=500)  # the fixed value, or the URL parameter name


class FieldMap(Strict):
    """Where the value goes on the contact: a standard field, a custom field (key) or a tag (the value
    becomes a tag name; for checkboxes every ticked option does)."""
    kind: Literal["none", "standard", "custom", "tag"] = "none"
    key: str = Field("", max_length=60)


class FormField(Strict):
    id: str = Field(pattern=ID)
    type: FieldType
    label: str = Field("", max_length=300)
    placeholder: str = Field("", max_length=200)
    help: str = Field("", max_length=500)
    required: bool = False
    default: str = Field("", max_length=500)
    width: Literal["full", "half"] = "full"
    step: int = Field(0, ge=0, le=9)
    options: list[FieldOption] = Field(default_factory=list, max_length=100)
    map_to: FieldMap = Field(default_factory=FieldMap)
    condition: FieldCondition | None = None
    hidden: HiddenSource | None = None
    # consent
    privacy_url: str | None = Field(None, max_length=500)
    consent_channels: list[Channel] = Field(default_factory=lambda: ["email"], max_length=3)
    # phone
    default_country: str | None = Field(None, pattern=r"^[A-Z]{2}$")
    # number / text
    min: float | None = None
    max: float | None = None
    max_length: int | None = Field(None, ge=1, le=5000)

    @field_validator("privacy_url")
    @classmethod
    def _privacy(cls, v):
        return http_url(v, "Privacy policy link")


class FormStep(Strict):
    id: str = Field(pattern=ID)
    title: str = Field("", max_length=120)


class FormDesign(Strict):
    theme: Literal["light", "dark"] = "light"
    primary_color: str = Field("#4f46e5", pattern=HEX)
    background_color: str = Field("#ffffff", pattern=HEX)
    text_color: str = Field("#0f172a", pattern=HEX)
    font: str = "system"
    use_site_font: bool = False
    radius: int = Field(8, ge=0, le=24)
    button_text: str = Field("Submit", min_length=1, max_length=60)
    button_color: str = Field("#4f46e5", pattern=HEX)
    button_text_color: str = Field("#ffffff", pattern=HEX)
    label_position: Literal["top", "left", "hidden"] = "top"
    max_width: int = Field(560, ge=280, le=1000)
    show_title: bool = True

    @field_validator("font")
    @classmethod
    def _font(cls, v):
        return v if v in FONTS else "system"


class FormSuccess(Strict):
    mode: Literal["message", "redirect", "both"] = "message"
    message_html: str = Field("<p><strong>Thank you!</strong> We'll be in touch soon.</p>", max_length=5000)
    redirect_url: str | None = Field(None, max_length=1000)
    pass_values: bool = False
    redirect_delay: int = Field(3, ge=0, le=15)  # seconds, when showing the message and then redirecting

    @field_validator("redirect_url")
    @classmethod
    def _redirect(cls, v):
        return http_url(v, "Redirect URL")


class FormDisplay(Strict):
    mode: Literal["inline", "popup", "slide_in", "floating"] = "inline"
    trigger: Literal["load", "scroll", "exit", "click"] = "load"
    delay_seconds: int = Field(5, ge=0, le=300)
    scroll_percent: int = Field(50, ge=1, le=100)
    frequency: Literal["once", "days", "always"] = "days"
    frequency_days: int = Field(7, ge=1, le=365)
    hide_after_submit: bool = True
    devices: Literal["all", "desktop", "mobile"] = "all"
    position: Literal["bottom_right", "bottom_left"] = "bottom_right"
    button_label: str = Field("Contact us", min_length=1, max_length=40)


class FormSettings(Strict):
    list_ids: list[str] = Field(default_factory=list, max_length=20)
    tag_ids: list[str] = Field(default_factory=list, max_length=20)
    source: str = Field("", max_length=60)  # lead source label; defaults to the form name
    # Channels the act of submitting grants consent for (shown as consent_text under the button).
    subscribe_on_submit: list[Channel] = Field(default_factory=list, max_length=3)
    consent_text: str = Field("", max_length=1000)
    double_opt_in: bool = False
    confirm_sender_id: str | None = None  # a verified sender; the default verified sender when empty
    confirm_subject: str = Field("Please confirm your subscription", max_length=200)
    allowed_domains: list[str] = Field(default_factory=list, max_length=50)
    notify_user_ids: list[str] = Field(default_factory=list, max_length=25)
    notify_email: bool = True
    notify_in_app: bool = True
    assign_owner: bool = True  # run the CRM assignment rules
    set_lifecycle_lead: bool = True
    create_deal: bool = False
    deal_pipeline_id: str | None = None
    deal_stage_id: str | None = None
    deal_title: str = Field("{name} – {form}", max_length=200)
    duplicate: Literal["update", "create"] = "update"
    turnstile: bool = False

    @field_validator("allowed_domains")
    @classmethod
    def _domains(cls, v):
        out = []
        for d in v:
            d = (d or "").strip().lower()
            if not d:
                continue
            if len(d) > 253 or any(c in d for c in " <>\"'\\"):
                raise ValueError(f"'{d[:40]}' is not a valid domain")
            out.append(d)
        return out


class FormDefinition(Strict):
    title: str = Field("", max_length=200)
    description: str = Field("", max_length=1000)
    fields: list[FormField] = Field(default_factory=list, max_length=60)
    steps: list[FormStep] = Field(default_factory=lambda: [FormStep(id="step_1", title="")], min_length=1,
                                  max_length=10)
    design: FormDesign = Field(default_factory=FormDesign)
    success: FormSuccess = Field(default_factory=FormSuccess)
    display: FormDisplay = Field(default_factory=FormDisplay)
    settings: FormSettings = Field(default_factory=FormSettings)

    @model_validator(mode="after")
    def _consistent(self):
        ids = [f.id for f in self.fields]
        if len(ids) != len(set(ids)):
            raise ValueError("Each field needs a unique id")
        for f in self.fields:
            if f.step >= len(self.steps):
                f.step = len(self.steps) - 1
            if f.condition and (f.condition.field not in ids or f.condition.field == f.id):
                f.condition = None
        return self


# ------------------------------------------------------------------ management API

class FormCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    template: str | None = Field(None, max_length=40)


class FormUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    draft: FormDefinition | None = None


class EmbedInfo(BaseModel):
    script_url: str
    iframe_url: str
    hosted_url: str
    inline: str
    popup: str
    slide_in: str
    floating: str
    button: str


class FormListItem(BaseModel):
    id: str
    public_id: str
    name: str
    status: str
    template: str | None
    published_version: int | None
    has_unpublished_changes: bool
    views_30d: int
    submissions_30d: int
    conversion_30d: float  # submissions / views, 0..100
    last_submission_at: datetime | None
    created_at: datetime
    updated_at: datetime


class FormOut(BaseModel):
    id: str
    public_id: str
    name: str
    status: str  # draft | published | paused
    template: str | None
    draft: FormDefinition
    published_version: int | None
    published_at: datetime | None
    has_unpublished_changes: bool
    branding: bool  # Starter: "Powered by Signalcraft" badge
    embed: EmbedInfo
    created_at: datetime
    updated_at: datetime


class VersionOut(BaseModel):
    version: int
    created_at: datetime
    published_by_name: str | None


class SubmissionOut(BaseModel):
    id: str
    status: str
    spam_reason: str | None
    values: dict
    labels: dict[str, str]  # field id -> label (from the version submitted)
    contact_id: str | None
    contact_name: str | None
    deal_id: str | None
    page_url: str | None
    referrer: str | None
    utm: dict
    country: str | None
    created_at: datetime
    confirmed_at: datetime | None


class SpamUpdate(BaseModel):
    spam: bool


class DeveloperEmail(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    note: str = Field("", max_length=1000)


class CountRow(BaseModel):
    value: str
    count: int


class DailyRow(BaseModel):
    date: date
    views: int
    starts: int
    submissions: int


class AnalyticsOut(BaseModel):
    days: int
    views: int
    starts: int
    submissions: int
    conversion: float  # submissions / views %
    start_rate: float  # starts / views %
    completion_rate: float  # submissions / starts %
    daily: list[DailyRow]
    top_pages: list[CountRow]
    top_referrers: list[CountRow]
    top_utm_sources: list[CountRow]


class TemplateOut(BaseModel):
    key: str
    name: str
    description: str


# ------------------------------------------------------------------ public API

class SubmitIn(BaseModel):
    client_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    values: dict = Field(default_factory=dict)
    render_token: str = Field("", max_length=200)
    hp: str = Field("", max_length=500)  # honeypot: humans never fill it
    page_url: str | None = Field(None, max_length=2000)
    referrer: str | None = Field(None, max_length=2000)
    utm: dict = Field(default_factory=dict)
    turnstile_token: str | None = Field(None, max_length=4096)


class EventIn(BaseModel):
    type: Literal["view", "start"]

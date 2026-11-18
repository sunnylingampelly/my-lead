from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.common import ORMModel

EditorKind = Literal["visual", "html", "text"]
CampaignStatus = Literal["draft", "scheduled", "queued", "sending", "paused", "completed", "cancelled", "failed"]


class SenderCreate(BaseModel):
    from_name: str = Field(min_length=1, max_length=120)
    from_email: EmailStr
    reply_to: EmailStr | None = None

    @field_validator("from_email", "reply_to")
    @classmethod
    def _lower(cls, v):
        return v.strip().lower() if v else v


class SenderUpdate(BaseModel):
    from_name: str | None = Field(default=None, min_length=1, max_length=120)
    reply_to: EmailStr | None = None
    is_default: bool | None = None


class SenderOut(ORMModel):
    id: str
    from_name: str
    from_email: str
    reply_to: str | None
    status: str
    is_default: bool
    verified_at: datetime | None
    verification_sent_at: datetime | None
    created_at: datetime
    domain: str = ""


class TemplateBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    subject: str | None = Field(default=None, max_length=255)
    preheader: str | None = Field(default=None, max_length=255)
    editor: EditorKind = "visual"
    design: dict[str, Any] | None = None
    html: str | None = Field(default=None, max_length=2_000_000)
    text: str | None = Field(default=None, max_length=200_000)


class TemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    subject: str | None = Field(default=None, max_length=255)
    preheader: str | None = Field(default=None, max_length=255)
    editor: EditorKind | None = None
    design: dict[str, Any] | None = None
    html: str | None = Field(default=None, max_length=2_000_000)
    text: str | None = Field(default=None, max_length=200_000)


class TemplateOut(ORMModel):
    id: str
    name: str
    subject: str | None
    preheader: str | None
    editor: str
    design: dict | None
    html: str | None
    text: str | None
    created_at: datetime
    updated_at: datetime


class Audience(BaseModel):
    all: bool = False
    list_ids: list[str] = Field(default_factory=list, max_length=50)
    segment_ids: list[str] = Field(default_factory=list, max_length=50)


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    campaign_type: Literal["newsletter", "promotional", "announcement", "regular"] = "regular"
    template_id: str | None = Field(default=None, max_length=36)


class CampaignUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    campaign_type: Literal["newsletter", "promotional", "announcement", "regular"] | None = None
    sender_id: str | None = Field(default=None, max_length=36)
    reply_to: EmailStr | None = None
    subject: str | None = Field(default=None, max_length=255)
    preheader: str | None = Field(default=None, max_length=255)
    editor: EditorKind | None = None
    design: dict[str, Any] | None = None
    html: str | None = Field(default=None, max_length=2_000_000)
    text: str | None = Field(default=None, max_length=200_000)
    audience: Audience | None = None
    track_opens: bool | None = None
    track_clicks: bool | None = None


class CampaignStats(BaseModel):
    recipients: int = 0
    queued: int = 0
    sent: int = 0  # accepted by the provider
    delivered: int = 0
    bounced: int = 0
    hard_bounced: int = 0
    complained: int = 0
    failed: int = 0
    skipped: int = 0
    unique_opens: int = 0
    total_opens: int = 0
    unique_clicks: int = 0
    total_clicks: int = 0
    unsubscribed: int = 0


class CampaignOut(ORMModel):
    id: str
    name: str
    description: str | None
    campaign_type: str
    status: str
    sender_id: str | None
    from_name: str | None
    from_email: str | None
    reply_to: str | None
    subject: str | None
    preheader: str | None
    editor: str
    design: dict | None
    html: str | None
    text: str | None
    audience: dict
    track_opens: bool
    track_clicks: bool
    scheduled_at: datetime | None
    schedule_timezone: str | None
    provider: str | None
    recipient_count: int
    excluded: dict
    launched_at: datetime | None
    completed_at: datetime | None
    error: str | None
    created_at: datetime
    updated_at: datetime
    stats: CampaignStats | None = None


class CampaignListItem(ORMModel):
    id: str
    name: str
    campaign_type: str
    status: str
    subject: str | None
    audience: dict
    recipient_count: int
    scheduled_at: datetime | None
    launched_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    updated_at: datetime
    stats: CampaignStats | None = None


class Estimate(BaseModel):
    matched: int
    eligible: int
    excluded: dict[str, int]


class ScheduleRequest(BaseModel):
    scheduled_at: datetime
    timezone: str = Field(default="UTC", max_length=64)


class PreviewRequest(BaseModel):
    contact_id: str | None = Field(default=None, max_length=36)
    subject: str | None = None
    preheader: str | None = None
    html: str | None = None
    text: str | None = None


class PreviewOut(BaseModel):
    subject: str
    html: str
    text: str
    contact_label: str
    issues: dict


class TestSendRequest(BaseModel):
    emails: list[EmailStr] = Field(min_length=1, max_length=5)
    contact_id: str | None = Field(default=None, max_length=36)


class ReadinessCheck(BaseModel):
    key: str
    label: str
    ok: bool
    detail: str | None = None


class MessageOut(ORMModel):
    id: str
    contact_id: str | None
    to_email: str
    status: str
    error_code: str | None
    error_message: str | None
    bounce_type: str | None
    accepted_at: datetime | None
    delivered_at: datetime | None
    first_opened_at: datetime | None
    first_clicked_at: datetime | None
    open_count: int
    click_count: int
    unsubscribed_at: datetime | None
    created_at: datetime

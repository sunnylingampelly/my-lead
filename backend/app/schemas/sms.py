from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel
from app.schemas.email import Audience

Category = Literal["promotional", "transactional", "service"]


class DltConfigIn(BaseModel):
    principal_entity_id: str | None = Field(default=None, max_length=32)
    entity_name: str | None = Field(default=None, max_length=200)
    dlt_platform: str | None = Field(default=None, max_length=40)
    us_brand_id: str | None = Field(default=None, max_length=64)
    us_campaign_id: str | None = Field(default=None, max_length=64)
    attest: bool = False

    @field_validator("principal_entity_id")
    @classmethod
    def _pe(cls, v):
        if v and not v.strip().isdigit():
            raise ValueError("The Principal Entity ID contains only digits")
        return v.strip() if v else v


class DltConfigOut(ORMModel):
    principal_entity_id: str | None
    entity_name: str | None
    dlt_platform: str | None
    us_brand_id: str | None
    us_campaign_id: str | None
    attested_at: datetime | None
    attested_by_name: str | None = None


class SenderIn(BaseModel):
    sender_id: str = Field(min_length=3, max_length=20)
    country: Literal["IN", "US"]
    kind: Literal["promotional", "service", "transactional", "long_code", "toll_free", "short_code"]
    provider: Literal["simulation", "sns"] = "simulation"
    dlt_header_id: str | None = Field(default=None, max_length=32)

    @field_validator("sender_id")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        return v if v.startswith("+") else v.upper()


class SenderOut(ORMModel):
    id: str
    sender_id: str
    country: str
    kind: str
    provider: str
    dlt_header_id: str | None
    status: str
    is_default: bool
    attested_at: datetime | None
    created_at: datetime


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: Category = "promotional"
    body: str = Field(min_length=1, max_length=2000)
    sender_ref: str | None = Field(default=None, max_length=36)
    dlt_template_id: str | None = Field(default=None, max_length=32)
    dlt_template_text: str | None = Field(default=None, max_length=2000)


class TemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    category: Category | None = None
    body: str | None = Field(default=None, min_length=1, max_length=2000)
    sender_ref: str | None = Field(default=None, max_length=36)
    dlt_template_id: str | None = Field(default=None, max_length=32)
    dlt_template_text: str | None = Field(default=None, max_length=2000)


class TemplateOut(ORMModel):
    id: str
    name: str
    category: str
    body: str
    sender_ref: str | None
    dlt_template_id: str | None
    dlt_template_text: str | None
    dlt_match: bool | None = None
    created_at: datetime
    updated_at: datetime


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    category: Category = "promotional"
    template_id: str | None = Field(default=None, max_length=36)
    audience: Audience | None = None


class CampaignUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    category: Category | None = None
    sender_ref: str | None = Field(default=None, max_length=36)
    template_id: str | None = Field(default=None, max_length=36)
    body: str | None = Field(default=None, max_length=2000)
    append_opt_out: bool | None = None
    audience: Audience | None = None


class Stats(BaseModel):
    recipients: int = 0
    queued: int = 0
    deferred: int = 0
    sent: int = 0
    delivered: int = 0
    undelivered: int = 0
    failed: int = 0
    skipped: int = 0
    segments: int = 0
    cost: float = 0


class CampaignOut(ORMModel):
    id: str
    name: str
    description: str | None
    category: str
    status: str
    sender_ref: str | None
    template_id: str | None
    body: str | None
    append_opt_out: bool
    audience: dict
    scheduled_at: datetime | None
    schedule_timezone: str | None
    provider: str | None
    sender_snapshot: dict
    recipient_count: int
    excluded: dict
    estimated_cost: Decimal | None
    currency: str | None
    launched_at: datetime | None
    completed_at: datetime | None
    error: str | None
    created_at: datetime
    updated_at: datetime
    stats: Stats | None = None


class CampaignListItem(ORMModel):
    id: str
    name: str
    category: str
    status: str
    body: str | None
    recipient_count: int
    scheduled_at: datetime | None
    launched_at: datetime | None
    created_at: datetime
    updated_at: datetime
    currency: str | None
    stats: Stats | None = None


class MessageOut(ORMModel):
    id: str
    contact_id: str | None
    to_phone: str
    country: str | None
    status: str
    segments: int
    cost: Decimal | None
    encoding: str | None
    error_code: str | None
    error_message: str | None
    deferred_reason: str | None
    next_attempt_at: datetime | None
    accepted_at: datetime | None
    delivered_at: datetime | None
    failed_at: datetime | None
    created_at: datetime


class TestSend(BaseModel):
    phones: list[str] = Field(min_length=1, max_length=5)
    contact_id: str | None = Field(default=None, max_length=36)


class InboundSim(BaseModel):
    from_phone: str = Field(min_length=6, max_length=20)
    to_sender: str = Field(min_length=3, max_length=20)
    body: str = Field(min_length=1, max_length=320)
    event_id: str = Field(min_length=1, max_length=128)

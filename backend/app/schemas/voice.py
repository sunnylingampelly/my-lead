from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel
from app.schemas.email import Audience

Category = Literal["promotional", "transactional", "service"]
Language = Literal["en-IN", "hi-IN", "ta-IN", "te-IN", "en-US", "es-US"]


class CallerIn(BaseModel):
    number: str = Field(min_length=6, max_length=20)
    label: str | None = Field(default=None, max_length=80)
    country: Literal["IN", "US"]
    kind: Literal["series_140", "series_160", "local", "toll_free"]
    provider: Literal["simulation", "telnyx", "exotel", "twilio"] = "simulation"

    @field_validator("number")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = "".join(c for c in v if c.isdigit() or c == "+")
        return v if v.startswith("+") else f"+{v}"


class CallerOut(ORMModel):
    id: str
    number: str
    label: str | None
    country: str
    kind: str
    provider: str
    status: str
    is_default: bool
    attested_at: datetime | None
    created_at: datetime


class TtsIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    tts_text: str = Field(min_length=1, max_length=1500)
    tts_language: Language = "en-IN"
    tts_voice: Literal["female", "male"] = "female"


class AudioUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    tts_text: str | None = Field(default=None, min_length=1, max_length=1500)
    tts_language: Language | None = None
    tts_voice: Literal["female", "male"] | None = None


class AudioOut(ORMModel):
    id: str
    name: str
    kind: str
    content_type: str | None
    size_bytes: int | None
    duration_seconds: Decimal | None
    tts_text: str | None
    tts_language: str | None
    tts_voice: str | None
    created_at: datetime
    updated_at: datetime
    url: str | None = None  # signed playback URL for uploads


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    category: Category = "promotional"
    audio_id: str | None = Field(default=None, max_length=36)


class CampaignUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    category: Category | None = None
    caller_ref: str | None = Field(default=None, max_length=36)
    audio_id: str | None = Field(default=None, max_length=36)
    intro_text: str | None = Field(default=None, max_length=300)
    opt_out_keypress: bool | None = None
    max_attempts: int | None = Field(default=None, ge=1, le=3)
    retry_delay_minutes: int | None = Field(default=None, ge=5, le=1440)
    audience: Audience | None = None


class Stats(BaseModel):
    recipients: int = 0
    pending: int = 0
    deferred: int = 0
    in_progress: int = 0
    attempted: int = 0
    answered: int = 0
    voicemail: int = 0
    no_answer: int = 0
    busy: int = 0
    failed: int = 0
    skipped: int = 0
    opted_out: int = 0
    attempts: int = 0
    talk_seconds: int = 0
    billable_minutes: int = 0
    cost: float = 0


class CampaignOut(ORMModel):
    id: str
    name: str
    description: str | None
    category: str
    status: str
    caller_ref: str | None
    audio_id: str | None
    intro_text: str | None
    opt_out_keypress: bool
    max_attempts: int
    retry_delay_minutes: int
    audience: dict
    scheduled_at: datetime | None
    schedule_timezone: str | None
    provider: str | None
    snapshot: dict
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
    recipient_count: int
    scheduled_at: datetime | None
    launched_at: datetime | None
    created_at: datetime
    updated_at: datetime
    currency: str | None
    stats: Stats | None = None


class CallOut(ORMModel):
    id: str
    contact_id: str | None
    to_phone: str
    status: str
    attempts: int
    answered_by: str | None
    answered_at: datetime | None
    ended_at: datetime | None
    duration_seconds: int
    billable_minutes: int
    cost: Decimal | None
    opted_out: bool
    error_code: str | None
    error_message: str | None
    deferred_reason: str | None
    next_attempt_at: datetime | None
    created_at: datetime
    updated_at: datetime


class TestCall(BaseModel):
    phones: list[str] = Field(min_length=1, max_length=3)

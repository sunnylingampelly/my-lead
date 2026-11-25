"""Schemas for AI calling agents and the platform phone number pool (admin)."""
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.common import ORMModel

AgentLanguage = Literal["en-IN", "hi-IN", "ta-IN", "te-IN", "en-US", "es-US", "ar-AE"]
FieldType = Literal["text", "yes_no", "number", "date", "choice"]
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_INSTRUCTIONS = 8000
MAX_KNOWLEDGE = 60000
MAX_FIELDS = 15


class OutcomeField(BaseModel):
    key: str = Field(min_length=1, max_length=40)
    label: str = Field(min_length=1, max_length=80)
    type: FieldType = "text"
    options: list[str] | None = Field(default=None, max_length=20)
    description: str | None = Field(default=None, max_length=300)

    @field_validator("key")
    @classmethod
    def _key(cls, v: str) -> str:
        v = v.strip().lower()
        if not KEY_RE.match(v):
            raise ValueError("Use lowercase letters, numbers and underscores, starting with a letter")
        return v

    @model_validator(mode="after")
    def _options(self):
        if self.type == "choice":
            opts = [o.strip()[:60] for o in (self.options or []) if o and o.strip()]
            if len(opts) < 2:
                raise ValueError(f"“{self.label}” needs at least two options")
            self.options = list(dict.fromkeys(opts))
        else:
            self.options = None
        return self


def _check_fields(fields: list[OutcomeField] | None) -> list[OutcomeField] | None:
    if fields is None:
        return None
    if len(fields) > MAX_FIELDS:
        raise ValueError(f"Capture up to {MAX_FIELDS} fields")
    keys = [f.key for f in fields]
    if len(keys) != len(set(keys)):
        raise ValueError("Each field needs a different key")
    reserved = {"summary", "sentiment", "interest", "next_step", "callback_requested_at", "do_not_call"}
    clash = reserved & set(keys)
    if clash:
        raise ValueError(f"“{sorted(clash)[0]}” is captured automatically; use another key")
    return fields


def _phone(v: str | None) -> str | None:
    if v is None or not v.strip():
        return None
    n = "".join(c for c in v if c.isdigit() or c == "+")
    n = n if n.startswith("+") else f"+{n}"
    if not re.fullmatch(r"\+\d{8,15}", n):
        raise ValueError("Enter the number with its country code, for example +919876543210")
    return n


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    template: str | None = Field(default=None, max_length=40)
    language: AgentLanguage | None = None


class AgentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    language: AgentLanguage | None = None
    voice: Literal["female", "male"] | None = None
    goal: str | None = Field(default=None, max_length=300)
    greeting: str | None = Field(default=None, max_length=500)
    instructions: str | None = Field(default=None, max_length=MAX_INSTRUCTIONS)
    knowledge: str | None = Field(default=None, max_length=MAX_KNOWLEDGE)
    outcome_fields: list[OutcomeField] | None = None
    transfer_number: str | None = Field(default=None, max_length=20)
    max_call_minutes: int | None = Field(default=None, ge=1, le=15)

    @field_validator("outcome_fields")
    @classmethod
    def _fields(cls, v):
        return _check_fields(v)

    @field_validator("transfer_number")
    @classmethod
    def _transfer(cls, v):
        return _phone(v)


class AgentOut(ORMModel):
    id: str
    name: str
    status: str
    template: str | None
    language: str
    voice: str
    goal: str | None
    greeting: str
    instructions: str
    knowledge: str | None
    outcome_fields: list[dict]
    transfer_number: str | None
    max_call_minutes: int
    version: int
    created_at: datetime
    updated_at: datetime
    used_by: list[dict] = []


class AgentListItem(ORMModel):
    id: str
    name: str
    status: str
    template: str | None
    language: str
    goal: str | None
    version: int
    updated_at: datetime
    used_by: list[dict] = []


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class TestContact(BaseModel):
    first_name: str | None = Field(default=None, max_length=80)


class AgentTest(BaseModel):
    messages: list[ChatMessage] = Field(default_factory=list, max_length=60)
    contact: TestContact | None = None


class AgentEvaluate(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=80)
    contact: TestContact | None = None


class PoolNumberIn(BaseModel):
    number: str = Field(min_length=6, max_length=24)
    country: Literal["IN", "US"]
    kind: Literal["series_140", "series_160", "local", "toll_free"]
    provider: Literal["twilio", "exotel", "telnyx", "simulation"] = "twilio"
    provider_ref: str | None = Field(default=None, max_length=128)


class PoolAdd(BaseModel):
    numbers: list[PoolNumberIn] = Field(default_factory=list, max_length=1000)
    # Bulk paste: one number per line, optionally "number, kind, provider, provider_ref".
    bulk: str | None = Field(default=None, max_length=100_000)
    country: Literal["IN", "US"] | None = None
    kind: Literal["series_140", "series_160", "local", "toll_free"] | None = None
    provider: Literal["twilio", "exotel", "telnyx", "simulation"] = "twilio"

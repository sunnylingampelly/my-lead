import re
from datetime import datetime
from typing import Literal
from zoneinfo import available_timezones

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel

APP_COLORS = ("indigo", "violet", "sky", "emerald", "amber", "rose", "slate", "teal")
_TIMEZONES = None


# Legacy IANA aliases that browsers (e.g. Chrome on Windows) still report.
LEGACY_TIMEZONES = {"Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Saigon": "Asia/Ho_Chi_Minh"}


def _valid_tz(v: str) -> str:
    v = LEGACY_TIMEZONES.get(v, v)
    global _TIMEZONES
    if _TIMEZONES is None:
        _TIMEZONES = available_timezones() | {"UTC"}
    if v not in _TIMEZONES:
        raise ValueError("Unknown timezone")
    return v


class ApplicationCreate(BaseModel):
    organization_id: str = Field(min_length=36, max_length=36)
    name: str = Field(min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    color: Literal[APP_COLORS] = "indigo"  # type: ignore[valid-type]
    timezone: str = "UTC"
    default_country: str | None = Field(default=None, min_length=2, max_length=2)

    _tz = field_validator("timezone")(_valid_tz)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters")
        return v


class ApplicationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    color: Literal[APP_COLORS] | None = None  # type: ignore[valid-type]
    timezone: str | None = None
    default_country: str | None = Field(default=None, min_length=2, max_length=2)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        return _valid_tz(v) if v else v


class ApplicationDelete(BaseModel):
    confirm_name: str = Field(min_length=1, max_length=120)


class ApplicationOut(ORMModel):
    id: str
    organization_id: str
    name: str
    slug: str
    description: str | None
    color: str
    timezone: str
    default_country: str | None
    status: str
    created_at: datetime
    updated_at: datetime


class MyApplicationOut(ApplicationOut):
    role: str
    permissions: list[str]


_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class ApplicationSettingsOut(ORMModel):
    contact_identity_rule: str
    default_email_provider: str
    default_sms_provider: str
    default_voice_provider: str
    quiet_hours_start: str
    quiet_hours_end: str
    business_name: str | None = None
    business_address: str | None = None


class ApplicationSettingsUpdate(BaseModel):
    contact_identity_rule: Literal["email", "phone", "email_or_phone"] | None = None
    default_email_provider: Literal["simulation", "ses", "brevo"] | None = None
    default_sms_provider: Literal["simulation", "sns"] | None = None
    default_voice_provider: Literal["simulation", "telnyx", "exotel", "twilio"] | None = None
    quiet_hours_start: str | None = None
    quiet_hours_end: str | None = None
    business_name: str | None = Field(default=None, max_length=200)
    business_address: str | None = Field(default=None, max_length=1000)

    @field_validator("quiet_hours_start", "quiet_hours_end")
    @classmethod
    def _hhmm(cls, v: str | None) -> str | None:
        if v is not None and not _HHMM.match(v):
            raise ValueError("Use 24h HH:MM format")
        return v


class AppMemberOut(BaseModel):
    user_id: str
    full_name: str
    email: str
    org_role: str
    app_role: str | None
    effective_role: str
    access: Literal["org_wide", "explicit"]


class AppMemberAdd(BaseModel):
    user_id: str = Field(min_length=36, max_length=36)
    role: str | None = None

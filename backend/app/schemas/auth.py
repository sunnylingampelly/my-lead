import re
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.common import ORMModel

_PASSWORD_RULE = "Password must be at least 10 characters and include a letter and a number."


def _check_password(v: str) -> str:
    if len(v) < 10 or len(v) > 128 or not re.search(r"[A-Za-z]", v) or not re.search(r"\d", v):
        raise ValueError(_PASSWORD_RULE)
    return v


def _normalise_email(v: str) -> str:
    return v.strip().lower()


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    full_name: str = Field(min_length=1, max_length=150)
    invitation_token: str | None = Field(default=None, max_length=200)

    _pw = field_validator("password")(_check_password)
    _em = field_validator("email")(_normalise_email)

    @field_validator("full_name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Full name is required")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)

    _em = field_validator("email")(_normalise_email)


class TokenRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)


class EmailRequest(BaseModel):
    email: EmailStr

    _em = field_validator("email")(_normalise_email)


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=1, max_length=128)

    _pw = field_validator("new_password")(_check_password)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)

    _pw = field_validator("new_password")(_check_password)


class UserOut(ORMModel):
    id: str
    email: str
    full_name: str
    timezone: str
    email_verified: bool
    is_platform_admin: bool
    platform_role: str | None = None
    last_organization_id: str | None = None
    last_application_id: str | None = None
    created_at: datetime


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserOut


class SessionOut(ORMModel):
    id: str
    user_agent: str | None
    ip_address: str | None
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime
    current: bool = False


class UpdateProfileRequest(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=150)
    timezone: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str | None) -> str | None:
        from app.schemas.application import _valid_tz

        return _valid_tz(v) if v else v


class UpdateContextRequest(BaseModel):
    organization_id: str | None = Field(default=None, max_length=36)
    application_id: str | None = Field(default=None, max_length=36)

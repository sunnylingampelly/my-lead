from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, HttpUrl, field_validator

from app.core.permissions import Role
from app.schemas.common import ORMModel


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    industry: str | None = Field(default=None, max_length=80)
    website: HttpUrl | None = None
    country: str | None = Field(default=None, min_length=2, max_length=2)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters")
        return v

    @field_validator("country")
    @classmethod
    def _upper(cls, v: str | None) -> str | None:
        return v.upper() if v else v


class OrganizationUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    industry: str | None = Field(default=None, max_length=80)
    website: HttpUrl | None = None
    country: str | None = Field(default=None, min_length=2, max_length=2)
    # Require two-factor authentication for owners and admins.
    require_mfa_admins: bool | None = None


class OrganizationOut(ORMModel):
    id: str
    name: str
    slug: str
    status: str
    industry: str | None
    website: str | None
    country: str | None
    created_at: datetime
    require_mfa_admins: bool = False


class MyOrganizationOut(OrganizationOut):
    role: str
    role_label: str
    permissions: list[str]
    application_count: int = 0
    # This owner/admin must set up two-factor before org admin actions work again.
    mfa_setup_required: bool = False
    # Set when platform staff see this organization through a read-only support session.
    support_access_expires_at: datetime | None = None


class MemberUser(ORMModel):
    id: str
    email: str
    full_name: str


class MemberOut(BaseModel):
    id: str
    user: MemberUser
    role: str
    role_label: str
    application_ids: list[str]
    created_at: datetime


class MemberUpdate(BaseModel):
    role: Role | None = None
    # Replace the member's explicit application access (ignored for org-wide roles).
    application_ids: list[str] | None = Field(default=None, max_length=500)


class InvitationCreate(BaseModel):
    email: EmailStr
    role: Role
    application_ids: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("email")
    @classmethod
    def _norm(cls, v: str) -> str:
        return v.strip().lower()


class InvitationOut(ORMModel):
    id: str
    email: str
    role: str
    role_label: str
    application_ids: list[str]
    status: str
    expires_at: datetime
    created_at: datetime
    invited_by_name: str | None = None


class InvitationPreview(BaseModel):
    organization_name: str
    email: str
    role: str
    role_label: str
    expires_at: datetime
    status: str
    account_exists: bool


class RoleOut(BaseModel):
    key: str
    name: str
    description: str
    rank: int
    is_org_wide: bool
    permissions: list[str]
    assignable: bool


class AuditLogOut(ORMModel):
    id: str
    action: str
    summary: str | None
    target_type: str | None
    target_id: str | None
    application_id: str | None
    actor_name: str | None = None
    created_at: datetime

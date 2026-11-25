from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel

Channel = Literal["email", "sms", "voice"]
ContactStatus = Literal["active", "unsubscribed", "bounced", "blocked"]
Lifecycle = Literal["subscriber", "lead", "mql", "sql", "opportunity", "customer", "other"]


# ------------------------------------------------------------------ custom attributes

class AttributeCreate(BaseModel):
    key: str = Field(min_length=1, max_length=60, pattern=r"^[a-z][a-z0-9_]*$")
    label: str = Field(min_length=1, max_length=100)
    data_type: Literal["text", "number", "date", "boolean", "select"]
    options: list[str] = Field(default_factory=list, max_length=100)
    description: str | None = Field(default=None, max_length=255)

    @field_validator("options")
    @classmethod
    def _opts(cls, v: list[str]) -> list[str]:
        out = list(dict.fromkeys(o.strip() for o in v if o and o.strip()))
        if any(len(o) > 100 for o in out):
            raise ValueError("Options must be at most 100 characters")
        return out


class AttributeUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=100)
    options: list[str] | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=255)


class AttributeOut(ORMModel):
    id: str
    key: str
    label: str
    data_type: str
    options: list[str]
    description: str | None
    created_at: datetime


# ------------------------------------------------------------------ tags & lists

class TagCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = Field(default="slate", max_length=16)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Name is required")
        return v


class TagUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    color: str | None = Field(default=None, max_length=16)


class TagOut(ORMModel):
    id: str
    name: str
    color: str


class TagWithCount(TagOut):
    contact_count: int = 0
    created_at: datetime


class ListCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)


class ListUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)


class ListOut(ORMModel):
    id: str
    name: str
    description: str | None
    contact_count: int = 0
    created_at: datetime
    updated_at: datetime


class ContactIds(BaseModel):
    contact_ids: list[str] = Field(min_length=1, max_length=5000)


# ------------------------------------------------------------------ contacts

class ConsentInput(BaseModel):
    """Consent captured together with a contact. Never assumed: every flag defaults to False."""

    email: bool = False
    sms: bool = False
    voice: bool = False
    source: str | None = Field(default=None, max_length=255)
    evidence: str | None = Field(default=None, max_length=2000)
    consent_reference: str | None = Field(default=None, max_length=120)


class ContactBase(BaseModel):
    first_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    email: str | None = Field(default=None, max_length=320)
    phone: str | None = Field(default=None, max_length=40)
    phone_country: str | None = Field(default=None, min_length=2, max_length=2)
    company: str | None = Field(default=None, max_length=200)
    country: str | None = Field(default=None, max_length=60)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)
    source: str | None = Field(default=None, max_length=60)
    timezone: str | None = Field(default=None, max_length=64)
    attributes: dict[str, Any] = Field(default_factory=dict)


class ContactCrmFields(BaseModel):
    """Optional CRM fields set together with the contact (need crm.write)."""

    # A CRM company chosen in the form. The free-text company is set from it.
    company_id: str | None = Field(default=None, max_length=36)
    owner_id: str | None = Field(default=None, max_length=36)
    lifecycle_stage: Lifecycle | None = None


class ContactCreate(ContactBase, ContactCrmFields):
    tag_ids: list[str] = Field(default_factory=list, max_length=100)
    list_ids: list[str] = Field(default_factory=list, max_length=100)
    consent: ConsentInput = Field(default_factory=ConsentInput)


class ContactUpdate(ContactBase, ContactCrmFields):
    status: ContactStatus | None = None
    clear_owner: bool = False


class ConsentChange(BaseModel):
    channel: Channel
    status: Literal["granted", "revoked"]
    source: str | None = Field(default=None, max_length=255)
    evidence: str | None = Field(default=None, max_length=2000)
    consent_reference: str | None = Field(default=None, max_length=120)


class ContactListItem(BaseModel):
    id: str
    first_name: str | None
    last_name: str | None
    full_name: str
    email: str | None
    phone: str | None
    phone_display: str | None
    phone_country: str | None
    company: str | None
    city: str | None
    state: str | None
    country: str | None
    status: str
    email_consent: bool
    sms_consent: bool
    voice_consent: bool
    email_unsubscribed: bool
    sms_unsubscribed: bool
    voice_unsubscribed: bool
    tags: list[TagOut]
    created_at: datetime
    last_activity_at: datetime | None
    # CRM
    company_id: str | None = None
    owner_id: str | None = None
    owner_name: str | None = None
    lifecycle_stage: str | None = None
    lead_score: int = 0


class Eligibility(BaseModel):
    eligible: bool
    reasons: list[str]


class ContactDetail(ContactListItem):
    phone_type: str | None
    postal_code: str | None
    timezone: str | None
    source: str | None
    attributes: dict[str, Any]
    lists: list[dict]
    email_unsubscribed_at: datetime | None
    sms_unsubscribed_at: datetime | None
    voice_unsubscribed_at: datetime | None
    jurisdiction: str | None
    jurisdiction_name: str
    eligibility: dict[str, Eligibility]
    updated_at: datetime


class ContactFilters(BaseModel):
    search: str | None = Field(default=None, max_length=200)
    status: ContactStatus | None = None
    tag_id: str | None = Field(default=None, max_length=36)
    list_id: str | None = Field(default=None, max_length=36)
    segment_id: str | None = Field(default=None, max_length=36)
    eligible_for: Channel | None = None
    country: str | None = Field(default=None, max_length=2)
    # CRM: a user id, "me" or "unassigned".
    owner_id: str | None = Field(default=None, max_length=36)
    lifecycle_stage: Lifecycle | None = None
    min_lead_score: int | None = Field(default=None, ge=-100000, le=100000)


class BulkAction(BaseModel):
    action: Literal["delete", "add_tag", "remove_tag", "add_to_list", "remove_from_list", "assign_owner",
                    "set_lifecycle"]
    contact_ids: list[str] | None = Field(default=None, max_length=5000)
    # Apply to every contact matching these filters instead of explicit ids.
    filters: ContactFilters | None = None
    tag_id: str | None = Field(default=None, max_length=36)
    list_id: str | None = Field(default=None, max_length=36)
    # assign_owner: a team member's id, or null to clear the owner.
    owner_id: str | None = Field(default=None, max_length=36)
    lifecycle_stage: Lifecycle | None = None


class ActivityOut(ORMModel):
    id: str
    type: str
    description: str
    meta: dict
    created_at: datetime
    actor_name: str | None = None


class ConsentRecordOut(ORMModel):
    id: str
    channel: str
    status: str
    method: str
    source: str | None
    evidence: str | None
    consent_reference: str | None
    jurisdiction: str | None
    created_at: datetime
    recorded_by_name: str | None = None


# ------------------------------------------------------------------ segments

class SegmentCondition(BaseModel):
    type: Literal["condition"] = "condition"
    field: str = Field(min_length=1, max_length=80)
    operator: str = Field(min_length=1, max_length=30)
    value: Any = None


class SegmentGroup(BaseModel):
    type: Literal["group"] = "group"
    match: Literal["all", "any"] = "all"
    conditions: list["SegmentCondition | SegmentGroup"] = Field(default_factory=list, max_length=50)


SegmentGroup.model_rebuild()


class SegmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    rules: SegmentGroup


class SegmentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    rules: SegmentGroup | None = None


class SegmentOut(ORMModel):
    id: str
    name: str
    description: str | None
    rules: dict
    last_count: int | None
    last_counted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class SegmentPreviewRequest(BaseModel):
    rules: SegmentGroup


class SegmentPreview(BaseModel):
    count: int
    eligible: dict[str, int]
    sample: list[ContactListItem]


# ------------------------------------------------------------------ suppression

class SuppressionCreate(BaseModel):
    channel: Channel
    value: str = Field(min_length=3, max_length=320)
    reason: Literal["manual", "unsubscribed", "bounced", "complaint", "dnd", "invalid"] = "manual"
    note: str | None = Field(default=None, max_length=255)


class SuppressionOut(ORMModel):
    id: str
    channel: str
    value_masked: str
    reason: str
    source: str | None
    note: str | None
    created_at: datetime


# ------------------------------------------------------------------ imports

class ImportConsentOptions(BaseModel):
    email: bool = False
    sms: bool = False
    voice: bool = False
    source: str | None = Field(default=None, max_length=255)
    evidence: str | None = Field(default=None, max_length=2000)
    consent_reference: str | None = Field(default=None, max_length=120)
    confirmed: bool = False


class ImportOptions(BaseModel):
    duplicate_handling: Literal["skip", "update"] = "skip"
    list_id: str | None = Field(default=None, max_length=36)
    new_list_name: str | None = Field(default=None, max_length=120)
    tag_names: list[str] = Field(default_factory=list, max_length=20)
    consent: ImportConsentOptions = Field(default_factory=ImportConsentOptions)
    source: str | None = Field(default=None, max_length=60)
    # Create a CRM company for company names that don't match one yet (otherwise only existing ones link).
    create_companies: bool = False


class ImportMappingRequest(BaseModel):
    mapping: dict[str, str] = Field(max_length=200)


class ImportStartRequest(BaseModel):
    mapping: dict[str, str] = Field(max_length=200)
    options: ImportOptions


class ImportOut(ORMModel):
    id: str
    file_name: str
    file_type: str
    file_size: int
    columns: list[str]
    preview: list[dict]
    mapping: dict
    options: dict
    status: str
    total_rows: int
    processed_rows: int
    created_count: int
    updated_count: int
    skipped_count: int
    duplicate_count: int
    invalid_count: int
    failed_count: int
    error: str | None
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
    progress: float = 0
    suggested_mapping: dict[str, str] = Field(default_factory=dict)


class ImportValidation(BaseModel):
    total_rows: int
    valid_rows: int
    new_contacts: int
    existing_matches: int
    duplicates_in_file: int
    invalid_rows: int
    empty_rows: int
    errors: list[dict]
    countries: dict[str, int]
    us_numbers: int
    india_numbers: int

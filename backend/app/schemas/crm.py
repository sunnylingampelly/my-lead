"""CRM request and response models."""
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel

Lifecycle = Literal["subscriber", "lead", "mql", "sql", "opportunity", "customer", "other"]
LIFECYCLE_VALUES = ("subscriber", "lead", "mql", "sql", "opportunity", "customer", "other")
StageKind = Literal["open", "won", "lost"]
TaskType = Literal["call", "email", "meeting", "follow_up", "todo"]
Priority = Literal["low", "normal", "high"]
ActivityType = Literal["call", "meeting", "email", "whatsapp", "sms", "visit", "other"]
Money = Decimal


class UserRef(BaseModel):
    id: str
    full_name: str
    email: str | None = None


class Ref(BaseModel):
    id: str
    name: str


# ------------------------------------------------------------------ companies

class CompanyBase(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    domain: str | None = Field(default=None, max_length=253)
    industry: str | None = Field(default=None, max_length=100)
    size: Literal["1-10", "11-50", "51-200", "201-1000", "1000+"] | None = None
    annual_revenue: Money | None = Field(default=None, ge=0, max_digits=16, decimal_places=2)
    currency: Literal["INR", "USD"] | None = None
    phone: str | None = Field(default=None, max_length=30)
    website: str | None = Field(default=None, max_length=255)
    gstin: str | None = Field(default=None, max_length=20)
    pan: str | None = Field(default=None, max_length=10)
    gst_treatment: Literal["registered_regular", "registered_composition", "unregistered", "consumer", "overseas",
                           "sez"] | None = None
    country: str | None = Field(default=None, max_length=2)
    state: str | None = Field(default=None, max_length=100)
    city: str | None = Field(default=None, max_length=100)
    address: str | None = Field(default=None, max_length=500)
    postal_code: str | None = Field(default=None, max_length=20)
    description: str | None = Field(default=None, max_length=5000)
    owner_id: str | None = None
    attributes: dict | None = None


class CompanyCreate(CompanyBase):
    name: str = Field(min_length=1, max_length=200)
    allow_duplicate: bool = False


class CompanyUpdate(CompanyBase):
    pass


class CompanyOut(ORMModel):
    id: str
    name: str
    domain: str | None
    industry: str | None
    size: str | None
    annual_revenue: Money | None
    currency: str
    phone: str | None
    website: str | None
    gstin: str | None
    pan: str | None
    gst_treatment: str | None
    country: str | None
    state: str | None
    city: str | None
    address: str | None
    postal_code: str | None
    description: str | None
    owner: UserRef | None = None
    attributes: dict
    contact_count: int = 0
    open_deal_count: int = 0
    open_deal_value: Money = Decimal(0)
    created_at: datetime
    updated_at: datetime


class DuplicateMatch(BaseModel):
    id: str
    name: str
    matched_on: str  # domain|gstin|phone|name|email


# ------------------------------------------------------------------ pipelines

class StageIn(BaseModel):
    id: str | None = None  # existing stage to keep
    name: str = Field(min_length=1, max_length=80)
    probability: int = Field(ge=0, le=100)
    kind: StageKind = "open"
    rotting_days: int | None = Field(default=None, ge=1, le=365)


class PipelineCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    currency: Literal["INR", "USD"] | None = None
    stages: list[StageIn] | None = None  # default stages when omitted


class PipelineUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    currency: Literal["INR", "USD"] | None = None
    is_default: bool | None = None
    archived: bool | None = None
    stages: list[StageIn] | None = None


class StageOut(ORMModel):
    id: str
    name: str
    position: int
    probability: int
    kind: str
    rotting_days: int | None


class PipelineOut(ORMModel):
    id: str
    name: str
    currency: str
    is_default: bool
    archived: bool
    position: int
    stages: list[StageOut] = []


class LostReasonIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    active: bool = True


class LostReasonOut(ORMModel):
    id: str
    name: str
    position: int
    active: bool


# ------------------------------------------------------------------ deals

class DealBase(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    amount: Money | None = Field(default=None, ge=0, max_digits=16, decimal_places=2)
    currency: Literal["INR", "USD"] | None = None
    probability: int | None = Field(default=None, ge=0, le=100)
    expected_close_date: date | None = None
    source: str | None = Field(default=None, max_length=60)
    owner_id: str | None = None
    contact_id: str | None = None
    company_id: str | None = None
    attributes: dict | None = None


class DealCreate(DealBase):
    title: str = Field(min_length=1, max_length=200)
    pipeline_id: str | None = None  # default pipeline when omitted
    stage_id: str | None = None  # first open stage when omitted


class DealUpdate(DealBase):
    clear_probability: bool = False


class DealMove(BaseModel):
    stage_id: str
    position: int | None = Field(default=None, ge=0)
    lost_reason_id: str | None = None
    lost_note: str | None = Field(default=None, max_length=500)


class DealClose(BaseModel):
    outcome: Literal["won", "lost"]
    lost_reason_id: str | None = None
    lost_note: str | None = Field(default=None, max_length=500)


class DealContactIn(BaseModel):
    contact_id: str
    role: str | None = Field(default=None, max_length=60)


class ContactRef(BaseModel):
    id: str
    name: str
    email: str | None = None
    phone: str | None = None
    role: str | None = None
    reach: dict[str, bool] | None = None


class DealOut(BaseModel):
    id: str
    title: str
    pipeline_id: str
    stage_id: str
    stage_name: str
    amount: Money
    currency: str
    probability: int
    probability_overridden: bool
    weighted_amount: Money
    expected_close_date: date | None
    status: str
    lost_reason: Ref | None = None
    lost_note: str | None
    source: str | None
    owner: UserRef | None = None
    contact: ContactRef | None = None
    company: Ref | None = None
    stage_entered_at: datetime
    last_activity_at: datetime
    rotting: bool
    rotting_days: int | None = None
    days_in_stage: int
    closed_at: datetime | None
    position: int
    attributes: dict
    created_at: datetime
    updated_at: datetime


class DealDetail(DealOut):
    contacts: list[ContactRef] = []
    stage_history: list[dict] = []


class BoardColumn(BaseModel):
    stage: StageOut
    deals: list[DealOut]
    count: int
    total: Money
    weighted_total: Money


class Board(BaseModel):
    pipeline: PipelineOut
    columns: list[BoardColumn]
    open_total: Money
    weighted_total: Money


# ------------------------------------------------------------------ tasks, notes, activities

class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    type: TaskType = "todo"
    priority: Priority = "normal"
    due_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=5000)
    assignee_id: str | None = None
    contact_id: str | None = None
    deal_id: str | None = None
    company_id: str | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    type: TaskType | None = None
    priority: Priority | None = None
    due_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=5000)
    assignee_id: str | None = None
    status: Literal["open", "done"] | None = None


class TaskOut(BaseModel):
    id: str
    title: str
    type: str
    priority: str
    status: str
    due_at: datetime | None
    overdue: bool
    notes: str | None
    assignee: UserRef | None = None
    contact: ContactRef | None = None
    deal: Ref | None = None
    company: Ref | None = None
    completed_at: datetime | None
    created_at: datetime


class NoteCreate(BaseModel):
    body: str = Field(min_length=1, max_length=20000)
    pinned: bool = False
    contact_id: str | None = None
    deal_id: str | None = None
    company_id: str | None = None


class NoteUpdate(BaseModel):
    body: str | None = Field(default=None, min_length=1, max_length=20000)
    pinned: bool | None = None


class NoteOut(BaseModel):
    id: str
    body: str
    pinned: bool
    mentions: list[UserRef]
    author: UserRef | None = None
    contact_id: str | None
    deal_id: str | None
    company_id: str | None
    created_at: datetime
    updated_at: datetime


class ActivityCreate(BaseModel):
    type: ActivityType
    subject: str = Field(min_length=1, max_length=200)
    body: str | None = Field(default=None, max_length=10000)
    outcome: str | None = Field(default=None, max_length=40)
    duration_minutes: int | None = Field(default=None, ge=0, le=1440)
    occurred_at: datetime | None = None
    contact_id: str | None = None
    deal_id: str | None = None
    company_id: str | None = None


class TimelineItem(BaseModel):
    id: str
    kind: str  # activity|note|task|system|email|sms|sms_reply|call
    type: str
    title: str
    body: str | None = None
    occurred_at: datetime
    actor: UserRef | None = None
    meta: dict = {}


# ------------------------------------------------------------------ contacts (CRM fields)

class ContactCrmUpdate(BaseModel):
    owner_id: str | None = None
    company_id: str | None = None
    lifecycle_stage: Lifecycle | None = None
    clear_owner: bool = False
    clear_company: bool = False


class ContactCrmOut(BaseModel):
    contact_id: str
    owner: UserRef | None
    company: Ref | None
    lifecycle_stage: str
    fit_score: int
    engagement_score: int
    lead_score: int
    grade: str
    hot: bool
    sla_due_at: datetime | None
    first_response_at: datetime | None
    sla_breached_at: datetime | None
    open_deals: int
    open_tasks: int


class LeadRow(BaseModel):
    id: str
    name: str
    email: str | None
    phone: str | None
    company: Ref | None
    owner: UserRef | None
    lifecycle_stage: str
    lead_score: int
    fit_score: int
    engagement_score: int
    grade: str
    source: str | None
    sla_due_at: datetime | None
    sla_breached_at: datetime | None
    first_response_at: datetime | None
    created_at: datetime


# ------------------------------------------------------------------ rules and settings

class AssignmentRuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    active: bool = True
    conditions: dict = {}
    user_ids: list[str] = Field(min_length=1, max_length=100)
    max_open_per_user: int | None = Field(default=None, ge=1, le=100000)

    @field_validator("conditions")
    @classmethod
    def _conditions(cls, v: dict) -> dict:
        allowed = {"source", "country", "state", "city", "segment_id", "lifecycle_stage"}
        bad = set(v) - allowed
        if bad:
            raise ValueError(f"Unknown conditions: {', '.join(sorted(bad))}")
        return {k: str(val)[:200] for k, val in v.items() if val not in (None, "")}


class AssignmentRuleOut(ORMModel):
    id: str
    name: str
    active: bool
    position: int
    conditions: dict
    user_ids: list[str]
    max_open_per_user: int | None
    assigned_count: int


class ScoringRuleIn(BaseModel):
    kind: Literal["fit", "engagement"]
    field: str | None = Field(default=None, max_length=60)
    operator: Literal["eq", "neq", "contains", "set", "not_set"] | None = None
    value: str | None = Field(default=None, max_length=200)
    event: Literal["email_opened", "email_clicked", "email_bounced", "email_unsubscribed", "sms_delivered",
                   "sms_replied", "call_answered", "call_opted_out", "note_added", "activity_logged",
                   "deal_created", "form_submitted"] | None = None
    points: int = Field(ge=-100, le=100)
    max_points: int | None = Field(default=None, ge=1, le=1000)
    active: bool = True


class ScoringRuleOut(ORMModel):
    id: str
    kind: str
    field: str | None
    operator: str | None
    value: str | None
    event: str | None
    points: int
    max_points: int | None
    active: bool


class CrmSettingsIn(BaseModel):
    engagement_window_days: int | None = Field(default=None, ge=1, le=365)
    hot_score_threshold: int | None = Field(default=None, ge=1, le=1000)
    sla_enabled: bool | None = None
    sla_minutes: int | None = Field(default=None, ge=1, le=10080)


class CrmSettingsOut(ORMModel):
    engagement_window_days: int
    hot_score_threshold: int
    sla_enabled: bool
    sla_minutes: int

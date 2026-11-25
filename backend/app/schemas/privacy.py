from datetime import datetime

from pydantic import BaseModel, Field


class EraseRequest(BaseModel):
    # The user types ERASE to confirm.
    confirm: str = Field(min_length=1, max_length=20)


class EraseResult(BaseModel):
    contact_id: str
    already_erased: bool
    erased_at: datetime | None
    details: dict[str, int]


class DataRequestOut(BaseModel):
    id: str
    kind: str
    status: str
    contact_id: str
    subject_label: str | None
    application_id: str
    application_name: str | None
    requested_by_id: str | None
    requested_by_name: str | None
    details: dict
    created_at: datetime
    completed_at: datetime | None


class DataRequestPage(BaseModel):
    items: list[DataRequestOut]
    total: int
    page: int
    page_size: int

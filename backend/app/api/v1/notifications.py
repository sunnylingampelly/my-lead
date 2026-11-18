from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel

from app.api.deps import DB, CurrentUser
from app.schemas.common import ORMModel, Page, PageParams
from app.services import notification_service

router = APIRouter(prefix="/notifications", tags=["Notifications"])


class NotificationOut(ORMModel):
    id: str
    type: str
    level: str
    title: str
    body: str | None
    link: str | None
    organization_id: str | None
    application_id: str | None
    read_at: datetime | None
    created_at: datetime


class UnreadCount(BaseModel):
    unread: int


@router.get("", response_model=Page[NotificationOut])
def list_notifications(user: CurrentUser, db: DB, paging: Annotated[PageParams, Depends()], unread_only: bool = False):
    return notification_service.list_for(db, user.id, paging, unread_only)


@router.get("/unread-count", response_model=UnreadCount)
def unread_count(user: CurrentUser, db: DB):
    return UnreadCount(unread=notification_service.unread_count(db, user.id))


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
def mark_read(notification_id: str, user: CurrentUser, db: DB):
    notification_service.mark_read(db, user.id, notification_id)
    db.commit()


@router.post("/read-all", response_model=UnreadCount)
def mark_all_read(user: CurrentUser, db: DB):
    notification_service.mark_all_read(db, user.id)
    db.commit()
    return UnreadCount(unread=0)

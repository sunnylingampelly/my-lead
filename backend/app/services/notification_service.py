"""In-app notifications. Each notification belongs to exactly one user; nobody else can read it."""
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.errors import NotFound
from app.models import OrganizationMember
from app.models.notification import Notification
from app.schemas.common import Page, PageParams
from app.utils.time import utcnow


def notify(db: Session, user_id: str | None, *, type_: str, title: str, body: str | None = None,
           link: str | None = None, level: str = "info", organization_id: str | None = None,
           application_id: str | None = None) -> None:
    if not user_id:
        return
    db.add(Notification(user_id=user_id, type=type_, title=title[:160], body=(body or "")[:500] or None,
                        link=link, level=level, organization_id=organization_id, application_id=application_id))


def _visible(user_id: str):
    """A user's notifications, excluding those from organizations they no longer belong to."""
    member_orgs = select(OrganizationMember.organization_id).where(OrganizationMember.user_id == user_id)
    return select(Notification).where(
        Notification.user_id == user_id,
        (Notification.organization_id.is_(None)) | (Notification.organization_id.in_(member_orgs)),
    )


def list_for(db: Session, user_id: str, params: PageParams, unread_only: bool) -> Page:
    q = _visible(user_id)
    if unread_only:
        q = q.where(Notification.read_at.is_(None))
    total = db.scalar(select(func.count()).select_from(q.subquery())) or 0
    items = list(db.scalars(q.order_by(Notification.created_at.desc()).offset(params.offset).limit(params.page_size)))
    return Page(items=items, total=total, page=params.page, page_size=params.page_size)


def unread_count(db: Session, user_id: str) -> int:
    q = _visible(user_id).where(Notification.read_at.is_(None))
    return db.scalar(select(func.count()).select_from(q.subquery())) or 0


def mark_read(db: Session, user_id: str, notification_id: str) -> None:
    n = db.scalar(select(Notification).where(Notification.id == notification_id, Notification.user_id == user_id))
    if n is None:
        raise NotFound("Notification not found")
    if n.read_at is None:
        n.read_at = utcnow()


def mark_all_read(db: Session, user_id: str) -> int:
    return db.execute(update(Notification).where(Notification.user_id == user_id, Notification.read_at.is_(None))
                      .values(read_at=utcnow())).rowcount

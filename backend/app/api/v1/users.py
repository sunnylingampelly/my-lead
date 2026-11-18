from fastapi import APIRouter, Request, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.core.errors import NotFound
from app.models import UserSession
from app.schemas.auth import ChangePasswordRequest, SessionOut, UpdateContextRequest, UpdateProfileRequest, UserOut
from app.schemas.common import Message
from app.services import audit_service, auth_service
from app.services.tenancy import resolve_app_context, resolve_org_context
from app.utils.time import utcnow

router = APIRouter(prefix="/users/me", tags=["Profile"])


@router.get("", response_model=UserOut)
def me(user: CurrentUser):
    return UserOut.model_validate(user)


@router.patch("", response_model=UserOut)
def update_profile(body: UpdateProfileRequest, user: CurrentUser, db: DB):
    if body.full_name is not None:
        user.full_name = body.full_name.strip() or user.full_name
    if body.timezone is not None:
        user.timezone = body.timezone
    audit_service.record(db, "user.profile_updated", actor_user_id=user.id, target_type="user", target_id=user.id)
    db.commit()
    return UserOut.model_validate(user)


@router.post("/password", response_model=Message)
def change_password(body: ChangePasswordRequest, request: Request, user: CurrentUser, db: DB):
    auth_service.change_password(db, user, current_password=body.current_password, new_password=body.new_password,
                                 current_session_id=getattr(request.state, "session_id", None))
    db.commit()
    return Message(message="Password changed. Other sessions were signed out.")


@router.put("/context", response_model=UserOut)
def set_context(body: UpdateContextRequest, user: CurrentUser, db: DB):
    """Remember the organization and application the user last worked in. Membership is verified."""
    if body.application_id:
        ctx = resolve_app_context(db, user, body.application_id)
        user.last_organization_id = ctx.organization_id
        user.last_application_id = ctx.application_id
    elif body.organization_id:
        resolve_org_context(db, user, body.organization_id)
        if user.last_organization_id != body.organization_id:
            user.last_application_id = None
        user.last_organization_id = body.organization_id
    db.commit()
    return UserOut.model_validate(user)


@router.get("/sessions", response_model=list[SessionOut])
def sessions(request: Request, user: CurrentUser, db: DB):
    rows = db.scalars(
        select(UserSession).where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None),
                                  UserSession.expires_at > utcnow()).order_by(UserSession.last_used_at.desc())
    )
    current = getattr(request.state, "session_id", None)
    out = []
    for s in rows:
        item = SessionOut.model_validate(s)
        item.current = s.id == current
        out.append(item)
    return out


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(session_id: str, user: CurrentUser, db: DB):
    s = db.scalar(select(UserSession).where(UserSession.id == session_id, UserSession.user_id == user.id))
    if s is None:
        raise NotFound("Session not found")
    auth_service.revoke_family(db, user.id, s.family_id, reason="user_revoked")
    db.commit()

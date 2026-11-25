from fastapi import APIRouter, Depends, Request, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser, ip_of
from app.api.v1.auth import user_out
from app.core.errors import NotFound
from app.core.rate_limit import rate_limit
from app.models import UserSession
from app.schemas.auth import (
    ChangePasswordRequest,
    MfaCodeRequest,
    MfaDisableRequest,
    MfaSetupOut,
    MfaStatusOut,
    PasswordConfirmRequest,
    RecoveryCodesOut,
    SessionOut,
    UpdateContextRequest,
    UpdateProfileRequest,
    UserOut,
)
from app.schemas.common import Message
from app.services import audit_service, auth_service, mfa_service
from app.services.tenancy import resolve_app_context, resolve_org_context
from app.utils.time import utcnow

router = APIRouter(prefix="/users/me", tags=["Profile"])


@router.get("", response_model=UserOut)
def me(user: CurrentUser, db: DB):
    return user_out(db, user)


@router.patch("", response_model=UserOut)
def update_profile(body: UpdateProfileRequest, user: CurrentUser, db: DB):
    if body.full_name is not None:
        user.full_name = body.full_name.strip() or user.full_name
    if body.timezone is not None:
        user.timezone = body.timezone
    audit_service.record(db, "user.profile_updated", actor_user_id=user.id, target_type="user", target_id=user.id)
    db.commit()
    return user_out(db, user)


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
    return user_out(db, user)


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


# ---------------------------------------------------------------- two-factor authentication

@router.get("/mfa", response_model=MfaStatusOut)
def mfa_status(user: CurrentUser, db: DB):
    return MfaStatusOut(**mfa_service.status(db, user))


@router.post("/mfa/setup", response_model=MfaSetupOut, dependencies=[Depends(rate_limit("mfa_setup", 10))])
def mfa_setup(user: CurrentUser, db: DB):
    """Start setup: a new secret as a QR code (SVG data URI) and a manual key. Nothing changes until it
    is confirmed with POST /users/me/mfa/enable."""
    out = mfa_service.start_setup(db, user)
    db.commit()
    return MfaSetupOut(**out)


@router.post("/mfa/enable", response_model=RecoveryCodesOut, dependencies=[Depends(rate_limit("mfa_enable", 10))])
def mfa_enable(body: MfaCodeRequest, request: Request, user: CurrentUser, db: DB):
    """Confirm setup with a code from the app. Returns 10 one-time recovery codes, shown only this once.
    Other sessions are signed out."""
    codes = mfa_service.enable(db, user, body.code, current_session_id=getattr(request.state, "session_id", None),
                               ip=ip_of(request))
    db.commit()
    return RecoveryCodesOut(recovery_codes=codes)


@router.post("/mfa/recovery-codes", response_model=RecoveryCodesOut,
             dependencies=[Depends(rate_limit("mfa_codes", 10))])
def mfa_regenerate_codes(body: PasswordConfirmRequest, request: Request, user: CurrentUser, db: DB):
    """Replace all recovery codes (the old ones stop working). Requires the password."""
    codes = mfa_service.regenerate_recovery_codes(db, user, body.password, ip=ip_of(request))
    db.commit()
    return RecoveryCodesOut(recovery_codes=codes)


@router.post("/mfa/disable", response_model=Message, dependencies=[Depends(rate_limit("mfa_disable", 10))])
def mfa_disable(body: MfaDisableRequest, request: Request, user: CurrentUser, db: DB):
    """Turn two-factor off. Requires the password and a current code (or a recovery code)."""
    mfa_service.disable(db, user, body.password, body.code, ip=ip_of(request))
    db.commit()
    return Message(message="Two-factor authentication is off")

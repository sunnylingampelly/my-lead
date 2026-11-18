"""Request dependencies: authentication and tenant context resolution."""
from typing import Annotated

import jwt
from fastapi import Depends, Path, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.errors import Forbidden, Unauthorized
from app.core.rate_limit import client_ip
from app.core.security import decode_access_token
from app.models import User
from app.services import auth_service
from app.services.tenancy import AppContext, OrgContext, resolve_app_context, resolve_org_context

_bearer = HTTPBearer(auto_error=False)

DB = Annotated[Session, Depends(get_db)]


def get_current_user(
    request: Request,
    db: DB,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise Unauthorized("Authentication required")
    try:
        payload = decode_access_token(creds.credentials)
    except jwt.ExpiredSignatureError as exc:
        raise Unauthorized("Access token expired", code="TOKEN_EXPIRED") from exc
    except jwt.InvalidTokenError as exc:
        raise Unauthorized("Invalid access token", code="INVALID_TOKEN") from exc
    # Checking the session makes logout and password changes take effect immediately.
    session = auth_service.get_active_session(db, payload["sid"])
    if session is None or session.user_id != payload["sub"]:
        raise Unauthorized("Session is no longer valid", code="SESSION_REVOKED")
    user = db.get(User, payload["sub"])
    if user is None or user.deleted_at is not None:
        raise Unauthorized("Account not found", code="INVALID_TOKEN")
    if not user.is_active:
        raise Forbidden("This account has been suspended", code="ACCOUNT_SUSPENDED")
    request.state.user_id = user.id
    request.state.session_id = session.id
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_org_context(organization_id: Annotated[str, Path(max_length=36)], db: DB, user: CurrentUser) -> OrgContext:
    return resolve_org_context(db, user, organization_id)


def get_app_context(app_id: Annotated[str, Path(max_length=36)], db: DB, user: CurrentUser) -> AppContext:
    return resolve_app_context(db, user, app_id)


OrgCtx = Annotated[OrgContext, Depends(get_org_context)]
AppCtx = Annotated[AppContext, Depends(get_app_context)]


def ip_of(request: Request) -> str:
    return client_ip(request)

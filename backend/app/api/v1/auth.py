from fastapi import APIRouter, Depends, Request, Response, status

from app.api.deps import DB, CurrentUser, ip_of
from app.core.config import settings
from app.core.errors import Unauthorized
from app.core.rate_limit import rate_limit
from app.schemas.auth import (
    AuthResponse,
    EmailRequest,
    LoginRequest,
    MfaChallengeOut,
    MfaLoginRequest,
    RegisterRequest,
    ResetPasswordRequest,
    TokenRequest,
    UserOut,
)
from app.schemas.common import Message
from app.services import auth_service, invitation_service, mfa_service

router = APIRouter(prefix="/auth", tags=["Authentication"])


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.REFRESH_COOKIE_NAME,
        token,
        max_age=settings.REFRESH_TOKEN_TTL_DAYS * 86400,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="strict",
        path=f"{settings.API_V1_PREFIX}/auth",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(settings.REFRESH_COOKIE_NAME, path=f"{settings.API_V1_PREFIX}/auth",
                           secure=settings.COOKIE_SECURE, httponly=True, samesite="strict")


def user_out(db, user) -> UserOut:
    out = UserOut.model_validate(user)
    out.mfa_setup_required = mfa_service.setup_required(db, user)
    out.mfa_recommended = bool(user.is_platform_admin) and not user.mfa_enabled
    return out


def _auth_response(response: Response, issued: auth_service.IssuedTokens, db=None) -> AuthResponse:
    _set_refresh_cookie(response, issued.refresh_token)
    user = user_out(db, issued.user) if db is not None else UserOut.model_validate(issued.user)
    return AuthResponse(access_token=issued.access_token, expires_in=issued.expires_in, user=user)


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED,
             dependencies=[Depends(rate_limit("register", settings.RATE_LIMIT_REGISTER_PER_MINUTE))])
def register(body: RegisterRequest, request: Request, response: Response, db: DB):
    """Create an account and sign in. A verification email is sent unless the user registered
    through an invitation link addressed to the same email, which proves inbox ownership."""
    ip = ip_of(request)
    user = auth_service.register(db, email=body.email, password=body.password, full_name=body.full_name, ip=ip)
    token = None
    if body.invitation_token:
        invitation_service.accept(db, user, body.invitation_token)
    else:
        token = auth_service.create_email_verification(db, user)
    issued = auth_service.issue_session(db, user, family_id=None, user_agent=request.headers.get("user-agent"), ip=ip)
    db.commit()
    if token:
        auth_service.send_verification_email(user, token)
    return _auth_response(response, issued)


@router.post("/login", response_model=AuthResponse | MfaChallengeOut, dependencies=[Depends(rate_limit("login"))])
def login(body: LoginRequest, request: Request, response: Response, db: DB):
    """Password sign-in. Accounts with two-factor authentication get `{"mfa_required": true,
    "code": "MFA_REQUIRED", "mfa_token": ...}` instead of tokens; finish with POST /auth/login/mfa."""
    issued = auth_service.login(db, email=body.email, password=body.password,
                                user_agent=request.headers.get("user-agent"), ip=ip_of(request))
    db.commit()
    if isinstance(issued, auth_service.MfaChallenge):
        return MfaChallengeOut(mfa_token=issued.token, expires_in=mfa_service.CHALLENGE_TTL_SECONDS)
    return _auth_response(response, issued, db)


@router.post("/login/mfa", response_model=AuthResponse, dependencies=[Depends(rate_limit("login_mfa", 20))])
def login_mfa(body: MfaLoginRequest, request: Request, response: Response, db: DB):
    """Second sign-in step: the challenge token from /auth/login plus a 6-digit authenticator code or a
    one-time recovery code. Five wrong codes in a row lock the second step for 15 minutes."""
    issued = auth_service.complete_mfa_login(db, token=body.mfa_token, code=body.code,
                                             user_agent=request.headers.get("user-agent"), ip=ip_of(request))
    db.commit()
    return _auth_response(response, issued, db)


@router.post("/refresh", response_model=AuthResponse, dependencies=[Depends(rate_limit("refresh", 120))])
def refresh(request: Request, response: Response, db: DB):
    """Exchange the httpOnly refresh cookie for a new access token. The refresh token rotates."""
    token = request.cookies.get(settings.REFRESH_COOKIE_NAME)
    if not token:
        raise Unauthorized("Not signed in", code="NO_REFRESH_TOKEN")
    try:
        issued = auth_service.refresh(db, refresh_token=token, user_agent=request.headers.get("user-agent"),
                                      ip=ip_of(request))
    except Unauthorized:
        _clear_refresh_cookie(response)
        raise
    db.commit()
    return _auth_response(response, issued, db)


@router.post("/logout", response_model=Message)
def logout(request: Request, response: Response, db: DB):
    """Revoke the current session family. Works with an expired access token, using the cookie."""
    auth_service.logout(db, session_id=None, refresh_token=request.cookies.get(settings.REFRESH_COOKIE_NAME))
    db.commit()
    _clear_refresh_cookie(response)
    return Message(message="Signed out")


@router.post("/verify-email", response_model=UserOut, dependencies=[Depends(rate_limit("verify", 30))])
def verify_email(body: TokenRequest, db: DB):
    user = auth_service.verify_email(db, body.token)
    db.commit()
    return UserOut.model_validate(user)


@router.post("/resend-verification", response_model=Message, dependencies=[Depends(rate_limit("resend", 5))])
def resend_verification(user: CurrentUser, db: DB):
    if user.email_verified:
        return Message(message="Email already verified")
    token = auth_service.create_email_verification(db, user)
    db.commit()
    auth_service.send_verification_email(user, token)
    return Message(message="Verification email sent")


@router.post("/forgot-password", response_model=Message, status_code=status.HTTP_202_ACCEPTED,
             dependencies=[Depends(rate_limit("forgot", 5))])
def forgot_password(body: EmailRequest, request: Request, db: DB):
    auth_service.request_password_reset(db, email=body.email, ip=ip_of(request))
    return Message(message="If an account exists for that email, a reset link has been sent")


@router.post("/reset-password", response_model=Message, dependencies=[Depends(rate_limit("reset", 10))])
def reset_password(body: ResetPasswordRequest, request: Request, response: Response, db: DB):
    auth_service.reset_password(db, token=body.token, new_password=body.new_password, ip=ip_of(request))
    db.commit()
    _clear_refresh_cookie(response)
    return Message(message="Password updated. Please sign in with your new password.")

"""Registration, login, refresh-token rotation, email verification and password reset."""
from dataclasses import dataclass
from datetime import timedelta
from urllib.parse import quote

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import AppError, Conflict, Forbidden, Unauthorized, ValidationFailed
from app.core.security import (
    DUMMY_PASSWORD_HASH,
    create_access_token,
    generate_token,
    hash_password,
    hash_token,
    password_needs_rehash,
    verify_password,
)
from app.models import EmailVerification, PasswordReset, User, UserSession
from app.models.base import new_uuid
from app.services import audit_service, mail_templates
from app.services.notifications import enqueue_system_email
from app.utils.time import utcnow


@dataclass
class IssuedTokens:
    user: User
    access_token: str
    expires_in: int
    refresh_token: str
    session: UserSession


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email.strip().lower(), User.deleted_at.is_(None)))


# ---------------------------------------------------------------- registration & verification

def register(db: Session, *, email: str, password: str, full_name: str, ip: str | None = None) -> User:
    if db.scalar(select(User.id).where(User.email == email)):
        raise Conflict("An account with this email already exists", code="EMAIL_TAKEN")
    user = User(email=email, password_hash=hash_password(password), full_name=full_name)
    db.add(user)
    db.flush()
    audit_service.record(db, "user.registered", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip)
    return user


def create_email_verification(db: Session, user: User) -> str:
    # Invalidate older outstanding links so only the newest works.
    db.execute(
        update(EmailVerification)
        .where(EmailVerification.user_id == user.id, EmailVerification.used_at.is_(None))
        .values(used_at=utcnow())
    )
    token = generate_token()
    now = utcnow()
    db.add(EmailVerification(user_id=user.id, email=user.email, token_hash=hash_token(token), created_at=now,
                             expires_at=now + timedelta(hours=settings.EMAIL_VERIFICATION_TTL_HOURS)))
    return token


def send_verification_email(user: User, token: str) -> None:
    url = f"{settings.FRONTEND_URL}/verify-email?token={quote(token)}"
    enqueue_system_email("email_verification", user.email, user.full_name,
                         mail_templates.verification_email(user.full_name, url))


def verify_email(db: Session, token: str) -> User:
    record = db.scalar(select(EmailVerification).where(EmailVerification.token_hash == hash_token(token)))
    if record is None or record.used_at is not None or record.expires_at < utcnow():
        raise ValidationFailed("This verification link is invalid or has expired", code="INVALID_TOKEN")
    user = db.get(User, record.user_id)
    if user is None or user.email != record.email:
        raise ValidationFailed("This verification link is invalid or has expired", code="INVALID_TOKEN")
    record.used_at = utcnow()
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        audit_service.record(db, "user.email_verified", actor_user_id=user.id, target_type="user", target_id=user.id)
    return user


# ---------------------------------------------------------------- sessions

def issue_session(db: Session, user: User, *, family_id: str | None, user_agent: str | None,
                  ip: str | None) -> IssuedTokens:
    refresh = generate_token(48)
    now = utcnow()
    session = UserSession(
        id=new_uuid(),
        user_id=user.id,
        family_id=family_id or new_uuid(),
        refresh_token_hash=hash_token(refresh),
        user_agent=(user_agent or "")[:255] or None,
        ip_address=ip,
        created_at=now,
        last_used_at=now,
        expires_at=now + timedelta(days=settings.REFRESH_TOKEN_TTL_DAYS),
    )
    db.add(session)
    access, ttl = create_access_token(user.id, session.id, user.is_platform_admin)
    return IssuedTokens(user=user, access_token=access, expires_in=ttl, refresh_token=refresh, session=session)


def login(db: Session, *, email: str, password: str, user_agent: str | None, ip: str | None) -> IssuedTokens:
    user = get_user_by_email(db, email)
    if user is None:
        verify_password(password, DUMMY_PASSWORD_HASH)  # equalise timing
        raise Unauthorized("Incorrect email or password", code="INVALID_CREDENTIALS")
    if not verify_password(password, user.password_hash):
        audit_service.record(db, "user.login_failed", actor_user_id=user.id, target_type="user", target_id=user.id,
                             ip_address=ip)
        db.commit()
        raise Unauthorized("Incorrect email or password", code="INVALID_CREDENTIALS")
    if not user.is_active:
        raise Forbidden("This account has been suspended", code="ACCOUNT_SUSPENDED")
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    user.last_login_at = utcnow()
    issued = issue_session(db, user, family_id=None, user_agent=user_agent, ip=ip)
    audit_service.record(db, "user.login", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip)
    return issued


def refresh(db: Session, *, refresh_token: str, user_agent: str | None, ip: str | None) -> IssuedTokens:
    """Rotate a refresh token. Presenting an already-rotated token revokes the entire family,
    because it means the token was copied."""
    session = db.scalar(
        select(UserSession).where(UserSession.refresh_token_hash == hash_token(refresh_token)).with_for_update()
    )
    if session is None:
        raise Unauthorized("Session expired. Please sign in again.", code="INVALID_REFRESH_TOKEN")
    now = utcnow()
    if session.revoked_at is not None:
        if session.revoked_reason == "rotated":
            revoke_family(db, session.user_id, session.family_id, reason="reuse_detected")
            audit_service.record(db, "user.refresh_token_reuse", actor_user_id=session.user_id,
                                 target_type="session", target_id=session.id, ip_address=ip)
            db.commit()
        raise Unauthorized("Session expired. Please sign in again.", code="INVALID_REFRESH_TOKEN")
    if session.expires_at < now:
        raise Unauthorized("Session expired. Please sign in again.", code="INVALID_REFRESH_TOKEN")
    user = db.get(User, session.user_id)
    if user is None or not user.is_active or user.deleted_at is not None:
        raise Unauthorized("Session expired. Please sign in again.", code="INVALID_REFRESH_TOKEN")
    issued = issue_session(db, user, family_id=session.family_id, user_agent=user_agent, ip=ip)
    session.revoked_at = now
    session.revoked_reason = "rotated"
    session.replaced_by_id = issued.session.id
    return issued


def revoke_family(db: Session, user_id: str, family_id: str, reason: str) -> None:
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.family_id == family_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason)
    )


def revoke_all_sessions(db: Session, user_id: str, reason: str, except_session_id: str | None = None) -> None:
    stmt = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_session_id:
        stmt = stmt.where(UserSession.id != except_session_id)
    db.execute(stmt.values(revoked_at=utcnow(), revoked_reason=reason))


def logout(db: Session, *, session_id: str | None, refresh_token: str | None) -> None:
    session = None
    if refresh_token:
        session = db.scalar(select(UserSession).where(UserSession.refresh_token_hash == hash_token(refresh_token)))
    if session is None and session_id:
        session = db.get(UserSession, session_id)
    if session is not None:
        revoke_family(db, session.user_id, session.family_id, reason="logout")


def get_active_session(db: Session, session_id: str) -> UserSession | None:
    s = db.get(UserSession, session_id)
    if s is None or s.revoked_at is not None or s.expires_at < utcnow():
        return None
    return s


# ---------------------------------------------------------------- password reset / change

def request_password_reset(db: Session, *, email: str, ip: str | None) -> None:
    """Always succeeds from the caller's point of view to prevent account enumeration."""
    user = get_user_by_email(db, email)
    if user is None or not user.is_active:
        return
    db.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
        .values(used_at=utcnow())
    )
    token = generate_token()
    now = utcnow()
    db.add(PasswordReset(user_id=user.id, token_hash=hash_token(token), created_at=now, request_ip=ip,
                         expires_at=now + timedelta(minutes=settings.PASSWORD_RESET_TTL_MINUTES)))
    audit_service.record(db, "user.password_reset_requested", actor_user_id=user.id, target_type="user",
                         target_id=user.id, ip_address=ip)
    db.commit()
    url = f"{settings.FRONTEND_URL}/reset-password?token={quote(token)}"
    enqueue_system_email("password_reset", user.email, user.full_name,
                         mail_templates.password_reset_email(user.full_name, url))


def reset_password(db: Session, *, token: str, new_password: str, ip: str | None) -> User:
    record = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hash_token(token)).with_for_update())
    if record is None or record.used_at is not None or record.expires_at < utcnow():
        raise ValidationFailed("This reset link is invalid or has expired", code="INVALID_TOKEN")
    user = db.get(User, record.user_id)
    if user is None or not user.is_active:
        raise ValidationFailed("This reset link is invalid or has expired", code="INVALID_TOKEN")
    record.used_at = utcnow()
    user.password_hash = hash_password(new_password)
    # Completing a reset proves inbox ownership.
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
    revoke_all_sessions(db, user.id, reason="password_reset")
    audit_service.record(db, "user.password_reset", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip)
    return user


def change_password(db: Session, user: User, *, current_password: str, new_password: str,
                    current_session_id: str | None) -> None:
    if not verify_password(current_password, user.password_hash):
        raise AppError("Current password is incorrect", code="INVALID_PASSWORD")
    if current_password == new_password:
        raise ValidationFailed("New password must be different from the current password")
    user.password_hash = hash_password(new_password)
    revoke_all_sessions(db, user.id, reason="password_changed", except_session_id=current_session_id)
    audit_service.record(db, "user.password_changed", actor_user_id=user.id, target_type="user", target_id=user.id)

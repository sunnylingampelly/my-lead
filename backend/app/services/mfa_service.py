"""Two-factor authentication: TOTP setup, recovery codes, the login challenge, lockout and org enforcement.

Flow
* Setup: a pending secret is generated (encrypted at rest) and shown as a QR code + manual key. It becomes
  active only when the user confirms a code from their app; 10 one-time recovery codes are shown once.
* Login: after a correct password, users with 2FA get a short-lived signed challenge token instead of a
  session. POST /auth/login/mfa exchanges token + code (TOTP or recovery code) for the session.
* Every failure counts against the user; MAX_FAILURES in a row locks the second step for LOCK_MINUTES.
* Codes are single-use: an accepted TOTP time step is remembered, and recovery codes are marked used.
"""
import hashlib
import hmac
import secrets
from datetime import timedelta

import jwt
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import totp
from app.core.config import settings
from app.core.crypto import decrypt_str, encrypt_str
from app.core.errors import AppError, Conflict, Forbidden, RateLimited, Unauthorized, ValidationFailed
from app.core.permissions import Role
from app.core.security import verify_password
from app.models import Organization, OrganizationMember, User, UserRecoveryCode
from app.services import audit_service
from app.utils.time import utcnow

CHALLENGE_TTL_SECONDS = 300
SETUP_TTL_MINUTES = 30
MAX_FAILURES = 5
LOCK_MINUTES = 15
RECOVERY_CODE_COUNT = 10
_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i


# ---------------------------------------------------------------- helpers

def _pw_fingerprint(user: User) -> str:
    """Binds a challenge to the current password: changing or resetting it voids outstanding challenges."""
    return hashlib.sha256(user.password_hash.encode()).hexdigest()[:16]


def _normalise_recovery(code: str) -> str:
    return "".join(ch for ch in (code or "").lower() if ch.isalnum())


def _hash_recovery(code: str) -> str:
    return hmac.new(settings.SECRET_KEY.encode(), _normalise_recovery(code).encode(), hashlib.sha256).hexdigest()


def _new_recovery_code() -> str:
    raw = "".join(secrets.choice(_ALPHABET) for _ in range(10))
    return f"{raw[:5]}-{raw[5:]}"


def recovery_codes_remaining(db: Session, user: User) -> int:
    return db.scalar(select(func.count(UserRecoveryCode.id)).where(
        UserRecoveryCode.user_id == user.id, UserRecoveryCode.used_at.is_(None))) or 0


def _issue_recovery_codes(db: Session, user: User) -> list[str]:
    db.query(UserRecoveryCode).filter(UserRecoveryCode.user_id == user.id).delete(synchronize_session=False)
    now = utcnow()
    codes = [_new_recovery_code() for _ in range(RECOVERY_CODE_COUNT)]
    db.add_all([UserRecoveryCode(user_id=user.id, code_hash=_hash_recovery(c), created_at=now) for c in codes])
    return codes


def org_requires_mfa(db: Session, user: User) -> bool:
    """True when the user is an owner/admin of an organization that requires two-factor."""
    return db.scalar(select(func.count(OrganizationMember.id)).join(
        Organization, Organization.id == OrganizationMember.organization_id).where(
        OrganizationMember.user_id == user.id, Organization.deleted_at.is_(None),
        Organization.require_mfa_admins.is_(True),
        OrganizationMember.role_key.in_([Role.OWNER.value, Role.ADMIN.value]))) > 0


def setup_required(db: Session, user: User) -> bool:
    return not user.mfa_enabled and org_requires_mfa(db, user)


def status(db: Session, user: User) -> dict:
    return {
        "enabled": user.mfa_enabled,
        "enabled_at": user.mfa_enabled_at,
        "recovery_codes_remaining": recovery_codes_remaining(db, user) if user.mfa_enabled else 0,
        "required_by_organization": org_requires_mfa(db, user),
        "recommended": bool(user.is_platform_admin) and not user.mfa_enabled,
    }


def _locked(user: User) -> bool:
    return user.mfa_locked_until is not None and user.mfa_locked_until > utcnow()


def _record_failure(db: Session, user: User, ip: str | None, context: str) -> None:
    user.mfa_failed_count = (user.mfa_failed_count or 0) + 1
    audit_service.record(db, "user.mfa_failed", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip, meta={"context": context, "failures": user.mfa_failed_count})
    if user.mfa_failed_count >= MAX_FAILURES:
        user.mfa_locked_until = utcnow() + timedelta(minutes=LOCK_MINUTES)
        user.mfa_failed_count = 0
        audit_service.record(db, "user.mfa_locked", actor_user_id=user.id, target_type="user", target_id=user.id,
                             ip_address=ip, meta={"minutes": LOCK_MINUTES})


def check_code(db: Session, user: User, code: str, *, ip: str | None, context: str,
               allow_recovery: bool = True) -> str:
    """Verify a TOTP or recovery code for a user with 2FA on. Returns "totp" or "recovery".

    Failures are counted and committed before the error is raised, so lockout survives the rollback."""
    if _locked(user):
        raise RateLimited("Too many incorrect codes. Try again in a few minutes.", code="MFA_LOCKED")
    method = None
    step = totp.verify(decrypt_str(user.mfa_secret), code, last_step=user.mfa_last_step)
    if step is not None:
        user.mfa_last_step = step
        method = "totp"
    elif allow_recovery and len(_normalise_recovery(code)) == 10:
        row = db.scalar(select(UserRecoveryCode).where(
            UserRecoveryCode.user_id == user.id, UserRecoveryCode.code_hash == _hash_recovery(code),
            UserRecoveryCode.used_at.is_(None)).with_for_update())
        if row is not None:
            row.used_at = utcnow()
            method = "recovery"
            audit_service.record(db, "user.mfa_recovery_code_used", actor_user_id=user.id, target_type="user",
                                 target_id=user.id, ip_address=ip,
                                 meta={"remaining": recovery_codes_remaining(db, user) - 1})
    if method is None:
        _record_failure(db, user, ip, context)
        db.commit()
        raise Unauthorized("That code is not valid. Check your authenticator app and try again.",
                           code="INVALID_MFA_CODE")
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    return method


# ---------------------------------------------------------------- setup / disable

def start_setup(db: Session, user: User) -> dict:
    if user.mfa_enabled:
        raise Conflict("Two-factor authentication is already on", code="MFA_ALREADY_ENABLED")
    secret = totp.new_secret()
    user.mfa_pending_secret = encrypt_str(secret)
    user.mfa_pending_at = utcnow()
    audit_service.record(db, "user.mfa_setup_started", actor_user_id=user.id, target_type="user", target_id=user.id)
    uri = totp.provisioning_uri(secret, user.email, settings.APP_NAME)
    return {"secret": secret, "otpauth_uri": uri, "qr_data_uri": totp.qr_data_uri(uri)}


def enable(db: Session, user: User, code: str, *, current_session_id: str | None, ip: str | None) -> list[str]:
    from app.services.auth_service import revoke_all_sessions

    if user.mfa_enabled:
        raise Conflict("Two-factor authentication is already on", code="MFA_ALREADY_ENABLED")
    if not user.mfa_pending_secret or user.mfa_pending_at is None or \
            user.mfa_pending_at < utcnow() - timedelta(minutes=SETUP_TTL_MINUTES):
        raise ValidationFailed("Setup expired. Start again to get a new QR code.", code="MFA_SETUP_EXPIRED")
    secret = decrypt_str(user.mfa_pending_secret)
    step = totp.verify(secret, code)
    if step is None:
        audit_service.record(db, "user.mfa_setup_failed", actor_user_id=user.id, target_type="user",
                             target_id=user.id, ip_address=ip)
        db.commit()
        raise ValidationFailed("That code is not valid. Check the time on your phone and try the newest code.",
                               code="INVALID_MFA_CODE")
    user.mfa_secret = user.mfa_pending_secret
    user.mfa_pending_secret = None
    user.mfa_pending_at = None
    user.mfa_enabled_at = utcnow()
    user.mfa_last_step = step
    user.mfa_failed_count = 0
    user.mfa_locked_until = None
    codes = _issue_recovery_codes(db, user)
    # Sessions opened before 2FA was on did not pass a second factor: sign them out (this one stays).
    revoke_all_sessions(db, user.id, reason="mfa_enabled", except_session_id=current_session_id)
    audit_service.record(db, "user.mfa_enabled", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip)
    return codes


def regenerate_recovery_codes(db: Session, user: User, password: str, *, ip: str | None) -> list[str]:
    if not user.mfa_enabled:
        raise ValidationFailed("Turn on two-factor authentication first", code="MFA_NOT_ENABLED")
    if not verify_password(password, user.password_hash):
        raise AppError("Current password is incorrect", code="INVALID_PASSWORD")
    codes = _issue_recovery_codes(db, user)
    audit_service.record(db, "user.mfa_recovery_codes_regenerated", actor_user_id=user.id, target_type="user",
                         target_id=user.id, ip_address=ip)
    return codes


def disable(db: Session, user: User, password: str, code: str, *, ip: str | None) -> None:
    if not user.mfa_enabled:
        raise ValidationFailed("Two-factor authentication is not on", code="MFA_NOT_ENABLED")
    if not verify_password(password, user.password_hash):
        raise AppError("Current password is incorrect", code="INVALID_PASSWORD")
    if org_requires_mfa(db, user):
        raise Forbidden("Your organization requires two-factor authentication for owners and admins",
                        code="MFA_REQUIRED_BY_ORGANIZATION")
    check_code(db, user, code, ip=ip, context="disable")
    user.mfa_secret = None
    user.mfa_enabled_at = None
    user.mfa_last_step = None
    db.query(UserRecoveryCode).filter(UserRecoveryCode.user_id == user.id).delete(synchronize_session=False)
    audit_service.record(db, "user.mfa_disabled", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip)


# ---------------------------------------------------------------- login challenge

def create_challenge(db: Session, user: User, ip: str | None) -> str:
    now = utcnow()
    payload = {"sub": user.id, "typ": "mfa", "pwh": _pw_fingerprint(user), "iat": int(now.timestamp()),
               "exp": int((now + timedelta(seconds=CHALLENGE_TTL_SECONDS)).timestamp()),
               "jti": secrets.token_hex(8)}
    audit_service.record(db, "user.mfa_challenge_issued", actor_user_id=user.id, target_type="user",
                         target_id=user.id, ip_address=ip)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def _invalid_challenge() -> Unauthorized:
    return Unauthorized("Your sign-in took too long. Enter your email and password again.",
                        code="MFA_CHALLENGE_EXPIRED")


def verify_challenge(db: Session, token: str, code: str, *, ip: str | None) -> tuple[User, str]:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM],
                             options={"require": ["exp", "sub", "typ", "pwh"]})
    except jwt.InvalidTokenError as exc:
        raise _invalid_challenge() from exc
    if payload.get("typ") != "mfa":
        raise _invalid_challenge()
    user = db.scalar(select(User).where(User.id == payload["sub"]).with_for_update())
    if user is None or user.deleted_at is not None or not user.mfa_enabled or \
            not hmac.compare_digest(payload["pwh"], _pw_fingerprint(user)):
        raise _invalid_challenge()
    if not user.is_active:
        raise Forbidden("This account has been suspended", code="ACCOUNT_SUSPENDED")
    method = check_code(db, user, code, ip=ip, context="login")
    audit_service.record(db, "user.mfa_verified", actor_user_id=user.id, target_type="user", target_id=user.id,
                         ip_address=ip, meta={"method": method})
    return user, method

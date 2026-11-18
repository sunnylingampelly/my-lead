"""Password hashing, JWT access tokens and opaque one-time tokens."""
import hashlib
import secrets
from datetime import timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import settings
from app.utils.time import utcnow

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


# A real hash used to equalise response timing when the user does not exist.
DUMMY_PASSWORD_HASH = _hasher.hash("timing-equaliser-not-a-real-password")


def create_access_token(user_id: str, session_id: str, is_platform_admin: bool = False) -> tuple[str, int]:
    ttl = settings.ACCESS_TOKEN_TTL_MINUTES * 60
    now = utcnow()
    payload = {
        "sub": user_id,
        "sid": session_id,
        "typ": "access",
        "adm": bool(is_platform_admin),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM), ttl


def decode_access_token(token: str) -> dict:
    payload = jwt.decode(
        token,
        settings.SECRET_KEY,
        algorithms=[settings.JWT_ALGORITHM],
        options={"require": ["exp", "sub", "sid", "typ"]},
    )
    if payload.get("typ") != "access":
        raise jwt.InvalidTokenError("wrong token type")
    return payload


def generate_token(nbytes: int = 32) -> str:
    """Opaque URL-safe token. Only its hash is persisted."""
    return secrets.token_urlsafe(nbytes)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

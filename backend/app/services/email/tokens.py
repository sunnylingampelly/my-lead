"""Compact signed tokens for tracking pixels, click links and unsubscribe links.

A token binds a purpose ("o" open, "c" click, "u" unsubscribe) to a message id with an HMAC, so
links cannot be forged or repurposed, and contain no personal data.
"""
import base64
import hashlib
import hmac
import uuid

from app.core.config import settings


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _mac(purpose: str, raw: bytes) -> bytes:
    key = hashlib.sha256(f"email-token:{settings.SECRET_KEY}".encode()).digest()
    return hmac.new(key, purpose.encode() + raw, hashlib.sha256).digest()[:12]


def make(purpose: str, message_id: str) -> str:
    raw = uuid.UUID(message_id).bytes
    return f"{_b64(raw)}.{_b64(_mac(purpose, raw))}"


def read(purpose: str, token: str) -> str | None:
    """Return the message id, or None if the token is malformed or not signed for this purpose."""
    try:
        a, b = token.split(".", 1)
        raw, sig = _unb64(a), _unb64(b)
        if len(raw) != 16 or not hmac.compare_digest(sig, _mac(purpose, raw)):
            return None
        return str(uuid.UUID(bytes=raw))
    except (ValueError, TypeError):
        return None

"""Time-based one-time passwords (RFC 6238, HOTP per RFC 4226): HMAC-SHA1, 30-second steps, 6 digits.

This is what Google Authenticator, Microsoft Authenticator, 1Password, Authy and friends implement."""
import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote, urlencode

STEP_SECONDS = 30
DIGITS = 6


def new_secret() -> str:
    """A random 160-bit secret, base32 without padding (the form authenticator apps expect)."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret_b32: str) -> bytes:
    s = secret_b32.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def hotp(key: bytes, counter: int, digits: int = DIGITS, digest=hashlib.sha1) -> str:
    mac = hmac.new(key, struct.pack(">Q", counter), digest).digest()
    offset = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def time_step(at: float | None = None) -> int:
    return int((time.time() if at is None else at) // STEP_SECONDS)


def code_at(secret_b32: str, at: float | None = None) -> str:
    return hotp(_key(secret_b32), time_step(at))


def verify(secret_b32: str, code: str, *, at: float | None = None, window: int = 1,
           last_step: int | None = None) -> int | None:
    """Return the matching time step when `code` is valid within ±window steps (clock drift), else None.

    Steps at or before `last_step` are refused so a code that was already used cannot be replayed."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != DIGITS or not code.isdigit():
        return None
    key = _key(secret_b32)
    now = time_step(at)
    for step in range(now - window, now + window + 1):
        if last_step is not None and step <= last_step:
            continue
        if hmac.compare_digest(hotp(key, step), code):
            return step
    return None


def provisioning_uri(secret_b32: str, account: str, issuer: str) -> str:
    label = quote(f"{issuer}:{account}", safe="@:")
    query = urlencode({"secret": secret_b32, "issuer": issuer, "algorithm": "SHA1", "digits": DIGITS,
                       "period": STEP_SECONDS})
    return f"otpauth://totp/{label}?{query}"


def qr_data_uri(text: str) -> str | None:
    """An SVG QR code as a data: URI (segno, pure Python). None when segno is unavailable."""
    try:
        import segno
    except ImportError:  # pragma: no cover - segno is in requirements.txt
        return None
    return segno.make(text, error="m").svg_data_uri(scale=5, border=2, dark="#111827", light="#ffffff")

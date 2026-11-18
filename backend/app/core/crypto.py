"""Encryption at rest for secrets such as provider credentials."""
import base64
import hashlib
import json
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings


def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.ENCRYPTION_KEY.encode()).digest())
    return Fernet(key)


def encrypt_str(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_str(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as exc:
        raise ValueError("Unable to decrypt secret; check ENCRYPTION_KEY") from exc


def encrypt_json(data: dict[str, Any]) -> str:
    return encrypt_str(json.dumps(data, separators=(",", ":")))


def decrypt_json(token: str) -> dict[str, Any]:
    return json.loads(decrypt_str(token))


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    return "****" + value[-4:] if len(value) > 8 else "****"

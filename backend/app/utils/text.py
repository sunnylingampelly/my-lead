import re
import secrets
import unicodedata


def slugify(value: str, max_length: int = 60) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return (value[:max_length].strip("-")) or "item"


def unique_suffix(n: int = 3) -> str:
    return secrets.token_hex(n)

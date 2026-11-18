"""Parse and verify provider webhooks into normalised events.

SES delivers events through Amazon SNS. Every SNS message is signed; we verify the signature with
the certificate at SigningCertURL, after checking that URL really belongs to Amazon SNS.
"""
import base64
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from urllib.parse import urlparse

import httpx
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

SNS_HOST_RE = re.compile(r"^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$")


@dataclass
class NormalizedEvent:
    provider_message_id: str
    type: str  # delivered|bounced|complained|opened|clicked|unsubscribed
    occurred_at: datetime
    event_id: str
    url: str | None = None
    bounce_type: str | None = None


class WebhookError(Exception):
    pass


def _ts(value: str | int | float | None) -> datetime:
    if value is None:
        return datetime.now(UTC)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC)
    v = value.replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(v)
    except ValueError:
        return datetime.now(UTC)
    return d if d.tzinfo else d.replace(tzinfo=UTC)


# ------------------------------------------------------------------ SNS / SES

@lru_cache(maxsize=16)
def _fetch_cert(url: str) -> bytes:
    resp = httpx.get(url, timeout=10)
    resp.raise_for_status()
    return resp.content


def _sns_string_to_sign(msg: dict) -> str:
    if msg.get("Type") == "Notification":
        keys = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    else:
        keys = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]
    out = ""
    for k in keys:
        if k in msg and msg[k] is not None:
            out += f"{k}\n{msg[k]}\n"
    return out


def verify_sns(msg: dict, fetch_cert: Callable[[str], bytes] = _fetch_cert) -> None:
    url = msg.get("SigningCertURL") or msg.get("SigningCertUrl") or ""
    parsed = urlparse(url)
    if parsed.scheme != "https" or not SNS_HOST_RE.match(parsed.hostname or "") or not parsed.path.endswith(".pem"):
        raise WebhookError("Untrusted signing certificate URL")
    try:
        cert = x509.load_pem_x509_certificate(fetch_cert(url))
        sig = base64.b64decode(msg["Signature"])
    except Exception as exc:  # noqa: BLE001
        raise WebhookError("Could not load signature or certificate") from exc
    algo = hashes.SHA256() if str(msg.get("SignatureVersion", "1")) == "2" else hashes.SHA1()  # noqa: S303 - SNS v1
    try:
        cert.public_key().verify(sig, _sns_string_to_sign(msg).encode(), padding.PKCS1v15(), algo)
    except InvalidSignature as exc:
        raise WebhookError("Invalid SNS signature") from exc


def parse_ses(sns: dict) -> list[NormalizedEvent]:
    """SES event publishing (eventType) and legacy notifications (notificationType)."""
    try:
        body = json.loads(sns.get("Message") or "{}")
    except ValueError as exc:
        raise WebhookError("Message is not JSON") from exc
    kind = body.get("eventType") or body.get("notificationType")
    mail = body.get("mail") or {}
    mid = mail.get("messageId")
    eid = sns.get("MessageId") or f"{mid}:{kind}"
    if not mid or not kind:
        return []
    if kind == "Delivery":
        return [NormalizedEvent(mid, "delivered", _ts((body.get("delivery") or {}).get("timestamp")), eid)]
    if kind == "Bounce":
        b = body.get("bounce") or {}
        return [NormalizedEvent(mid, "bounced", _ts(b.get("timestamp")), eid,
                                bounce_type="hard" if b.get("bounceType") == "Permanent" else "soft")]
    if kind == "Complaint":
        return [NormalizedEvent(mid, "complained", _ts((body.get("complaint") or {}).get("timestamp")), eid)]
    if kind == "Open":
        return [NormalizedEvent(mid, "opened", _ts((body.get("open") or {}).get("timestamp")), eid)]
    if kind == "Click":
        c = body.get("click") or {}
        return [NormalizedEvent(mid, "clicked", _ts(c.get("timestamp")), eid, url=c.get("link"))]
    if kind == "Subscription":
        return [NormalizedEvent(mid, "unsubscribed", _ts((body.get("subscription") or {}).get("timestamp")), eid)]
    return []


# ------------------------------------------------------------------ Brevo

BREVO_MAP = {"delivered": "delivered", "hard_bounce": "bounced", "soft_bounce": "bounced", "spam": "complained",
             "complaint": "complained", "opened": "opened", "unique_opened": "opened", "click": "clicked",
             "unsubscribed": "unsubscribed"}


def parse_brevo(payload: dict) -> list[NormalizedEvent]:
    event = payload.get("event")
    mid = payload.get("message-id") or payload.get("messageId")
    if event not in BREVO_MAP or not mid:
        return []
    ts = payload.get("ts_event") or payload.get("ts_epoch") or payload.get("date")
    if isinstance(ts, (int, float)) and ts > 1e11:  # milliseconds
        ts = ts / 1000
    eid = f"{mid}:{event}:{payload.get('id') or ts}"
    return [NormalizedEvent(mid, BREVO_MAP[event], _ts(ts), eid, url=payload.get("link"),
                            bounce_type="hard" if event == "hard_bounce" else ("soft" if event == "soft_bounce" else None))]

"""Hostile-input helpers for public lead forms: an allowlist HTML sanitiser for rich text, signed
render and confirmation tokens, IP hashing, rate limits and Cloudflare Turnstile verification."""
import base64
import hashlib
import hmac
import time
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlparse

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

# ------------------------------------------------------------------ rich text

_ALLOWED = {"p", "br", "strong", "b", "em", "i", "u", "a", "ul", "ol", "li", "h2", "h3", "h4", "span", "div"}
_VOID = {"br"}
_DROP_CONTENT = {"script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea",
                 "select", "title", "head"}


def safe_href(url: str | None) -> str | None:
    u = (url or "").strip()
    if not u or any(c in u for c in "\r\n\t<>\"'`"):
        return None
    p = urlparse(u)
    if p.scheme in ("http", "https") and p.netloc:
        return u
    if p.scheme == "mailto" and p.path:
        return u
    return None


class _Sanitiser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in _DROP_CONTENT:
            self.skip += 1
            return
        if self.skip or tag not in _ALLOWED:
            return
        if tag == "a":
            href = safe_href(dict(attrs).get("href"))
            if href is None:
                self.out.append("<a>")
            else:
                self.out.append(f'<a href="{escape(href, quote=True)}" target="_blank" rel="noopener noreferrer">')
        else:
            self.out.append(f"<{tag}>")
        if tag not in _VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag in _VOID and not self.skip:
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag in _DROP_CONTENT:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip or tag not in _ALLOWED or tag in _VOID or tag not in self.stack:
            return
        while self.stack:
            t = self.stack.pop()
            self.out.append(f"</{t}>")
            if t == tag:
                break

    def handle_data(self, data):
        if not self.skip:
            self.out.append(escape(data, quote=False))


def sanitize_html(html: str | None, max_len: int = 5000) -> str:
    """Keep simple formatting (paragraphs, bold, italics, lists, http(s)/mailto links); drop everything else.
    Attributes other than a link's href are removed, so no event handlers or styles survive."""
    p = _Sanitiser()
    p.feed((html or "")[: max_len * 2])
    p.close()
    while p.stack:
        p.out.append(f"</{p.stack.pop()}>")
    return "".join(p.out)[: max_len * 2]


# ------------------------------------------------------------------ signed tokens

def _key(purpose: str) -> bytes:
    return hashlib.sha256(f"lead-form:{purpose}:{settings.SECRET_KEY}".encode()).digest()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def sign(purpose: str, payload: str) -> str:
    raw = payload.encode()
    mac = hmac.new(_key(purpose), raw, hashlib.sha256).digest()[:16]
    return f"{_b64(raw)}.{_b64(mac)}"


def unsign(purpose: str, token: str | None) -> str | None:
    try:
        a, b = (token or "").split(".", 1)
        raw, mac = _unb64(a), _unb64(b)
        if not hmac.compare_digest(mac, hmac.new(_key(purpose), raw, hashlib.sha256).digest()[:16]):
            return None
        return raw.decode()
    except (ValueError, TypeError, UnicodeDecodeError):
        return None


def render_token(public_id: str, now: float | None = None) -> str:
    """Issued with every rendered form: proves when the form was shown (minimum time-to-submit)."""
    return sign("render", f"{public_id}|{int((now or time.time()) * 1000)}")


def rendered_at(public_id: str, token: str | None) -> float | None:
    """Seconds since epoch the form was rendered, or None for a forged/foreign token."""
    v = unsign("render", token)
    if not v or "|" not in v:
        return None
    pid, ms = v.rsplit("|", 1)
    if pid != public_id or not ms.isdigit():
        return None
    return int(ms) / 1000


CONFIRM_TTL_DAYS = 7


def confirm_token(submission_id: str, now: float | None = None) -> str:
    exp = int((now or time.time()) + CONFIRM_TTL_DAYS * 86400)
    return sign("confirm", f"{submission_id}|{exp}")


def read_confirm_token(token: str | None) -> tuple[str | None, bool]:
    """(submission_id, expired)."""
    v = unsign("confirm", token)
    if not v or "|" not in v:
        return None, False
    sid, exp = v.rsplit("|", 1)
    if not exp.isdigit():
        return None, False
    return sid, int(exp) < time.time()


def ip_hash(ip: str | None) -> str | None:
    if not ip:
        return None
    return hmac.new(_key("ip"), ip.encode(), hashlib.sha256).hexdigest()


# ------------------------------------------------------------------ rate limits

# Tunable (tests lower them). Windows are in seconds.
LIMITS = {
    "submit_ip": (10, 600),  # per IP per form: 10 submissions every 10 minutes
    "submit_form": (300, 60),  # per form, all visitors: 300 a minute
    "event_ip": (120, 60),  # view/start pings per IP
}


def over_limit(kind: str, key: str) -> bool:
    if not settings.RATE_LIMIT_ENABLED:
        return False
    from app.core.rate_limit import _get_backend

    limit, window = LIMITS[kind]
    bucket = int(time.time() // window)
    return _get_backend().hit(f"rl:form:{kind}:{key}:{bucket}", window) > limit


# ------------------------------------------------------------------ Turnstile

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def turnstile_available() -> bool:
    return bool(settings.TURNSTILE_SITE_KEY and settings.TURNSTILE_SECRET_KEY)


def verify_turnstile(token: str | None, ip: str | None) -> bool:
    if not token:
        return False
    try:
        import httpx

        r = httpx.post(TURNSTILE_VERIFY_URL, timeout=5.0,
                       data={"secret": settings.TURNSTILE_SECRET_KEY, "response": token, "remoteip": ip or ""})
        return bool(r.json().get("success"))
    except Exception:  # noqa: BLE001 - treat an outage as a failed check, never as a pass
        log.warning("turnstile_verify_failed")
        return False

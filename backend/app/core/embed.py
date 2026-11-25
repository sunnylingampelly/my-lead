"""Shared plumbing for things that run on customers' websites (lead forms, chat widget).

Embed endpoints are called from any website, so they get their own CORS policy: the caller's Origin is
echoed back, credentials are never allowed (embeds authenticate with public keys and signed visitor
tokens, not cookies), and only simple methods and headers pass. Which websites may actually use a given
form or chatbot is enforced per form/bot by `origin_allowed()` against its allowed-domains list.

Embed pages served for iframes must be frameable by the customer's site, so the global
`X-Frame-Options: DENY` is skipped for them; each page sets `Content-Security-Policy: frame-ancestors`
for its allowed domains instead (see `frame_ancestors()`).
"""
from urllib.parse import urlparse

from app.core.config import settings

API = settings.API_V1_PREFIX
# Everything under these prefixes is reachable from third-party websites.
EMBED_PREFIXES: tuple[str, ...] = ("/embed/", f"{API}/public/forms", f"{API}/public/chat")
ALLOWED_HEADERS = "Content-Type, X-Visitor-Token, X-Request-ID"
ALLOWED_METHODS = "GET, POST, OPTIONS"


def is_embed_path(path: str) -> bool:
    return path.startswith(EMBED_PREFIXES)


def cors_headers(origin: str | None) -> dict[str, str]:
    if not origin:
        return {}
    return {"Access-Control-Allow-Origin": origin, "Vary": "Origin",
            "Access-Control-Allow-Methods": ALLOWED_METHODS, "Access-Control-Allow-Headers": ALLOWED_HEADERS,
            "Access-Control-Max-Age": "600"}


def host_of(origin_or_url: str | None) -> str | None:
    if not origin_or_url:
        return None
    try:
        host = urlparse(origin_or_url if "//" in origin_or_url else f"//{origin_or_url}").hostname
    except ValueError:
        return None
    return host.lower().rstrip(".") if host else None


def normalise_domains(domains: list[str] | None) -> list[str]:
    """Accept 'example.com', 'https://www.example.com/path', '*.example.com'; keep hostnames (with '*.')."""
    out: list[str] = []
    for d in domains or []:
        d = (d or "").strip().lower()
        wildcard = d.startswith("*.")
        h = host_of(d[2:] if wildcard else d)
        if h and (("*." + h) if wildcard else h) not in out:
            out.append(("*." + h) if wildcard else h)
    return out


def validate_domains(domains: list[str] | None, *, limit: int = 20) -> list[str]:
    """Normalise a list of websites typed by a person, refusing entries that aren't a real hostname."""
    from app.core.errors import ValidationFailed

    out: list[str] = []
    for raw in domains or []:
        raw = (raw or "").strip()
        if not raw:
            continue
        norm = normalise_domains([raw])
        host = norm[0].removeprefix("*.") if norm else ""
        labels = host.split(".")
        ok = host == "localhost" or (
            len(labels) >= 2 and all(0 < len(p) <= 63 for p in labels)
            and all(c.isalnum() or c == "-" for p in labels for c in p) and not labels[-1].isdigit())
        if not ok:
            raise ValidationFailed(f"“{raw}” isn't a website address. Use a domain like example.com.",
                                   code="INVALID_DOMAIN", details={"field": "allowed_domains", "value": raw})
        if norm[0] not in out:
            out.append(norm[0])
    if len(out) > limit:
        raise ValidationFailed(f"Add at most {limit} websites", code="TOO_MANY_DOMAINS")
    return out


def origin_allowed(origin: str | None, allowed_domains: list[str] | None, *, empty_means_any: bool = True) -> bool:
    """'example.com' also covers 'www.example.com'; '*.example.com' covers every subdomain. Our own app origins
    are always allowed (previews, hosted pages). An empty allow-list means any website unless
    `empty_means_any=False` (chatbots: each AI reply costs money, so they only run where the owner said)."""
    domains = normalise_domains(allowed_domains)
    host = host_of(origin)
    own = {host_of(settings.FRONTEND_URL), host_of(settings.BACKEND_PUBLIC_URL)}
    if host and host in own:
        return True
    if not domains:
        return empty_means_any
    if not host:
        return False
    for d in domains:
        if d.startswith("*."):
            base = d[2:]
            if host == base or host.endswith("." + base):
                return True
        elif host == d or host == "www." + d:
            return True
    return False


def frame_ancestors(allowed_domains: list[str] | None, *, empty_means_any: bool = True) -> str:
    """CSP value letting the customer's pages (and our app, for previews) frame an embed page."""
    domains = normalise_domains(allowed_domains)
    own = " ".join(o for o in {settings.FRONTEND_URL.rstrip("/"), settings.BACKEND_PUBLIC_URL.rstrip("/")} if o)
    if not domains:
        return "frame-ancestors *" if empty_means_any else f"frame-ancestors 'self' {own}"
    srcs = []
    for d in domains:
        srcs += [f"https://{d}", f"http://{d}"] + ([] if d.startswith("*.") else [f"https://www.{d}"])
    return f"frame-ancestors 'self' {own} {' '.join(srcs)}"

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


def origin_allowed(origin: str | None, allowed_domains: list[str] | None) -> bool:
    """An empty allow-list means any website. 'example.com' also covers 'www.example.com';
    '*.example.com' covers every subdomain. Our own app origins are always allowed (previews, hosted pages)."""
    domains = normalise_domains(allowed_domains)
    host = host_of(origin)
    own = {host_of(settings.FRONTEND_URL), host_of(settings.BACKEND_PUBLIC_URL)}
    if host and host in own:
        return True
    if not domains:
        return True
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


def frame_ancestors(allowed_domains: list[str] | None) -> str:
    """CSP value letting the customer's pages (and our app, for previews) frame an embed page."""
    domains = normalise_domains(allowed_domains)
    own = " ".join(o for o in {settings.FRONTEND_URL.rstrip("/"), settings.BACKEND_PUBLIC_URL.rstrip("/")} if o)
    if not domains:
        return "frame-ancestors *"
    srcs = []
    for d in domains:
        srcs += [f"https://{d}", f"http://{d}"] + ([] if d.startswith("*.") else [f"https://www.{d}"])
    return f"frame-ancestors 'self' {own} {' '.join(srcs)}"

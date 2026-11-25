"""Sentry error reporting without personal data.

Active only when SENTRY_DSN is set. send_default_pii is off (no IPs, cookies or user details), request bodies
are never attached, and before_send scrubs anything that slipped through: credential headers, cookies, token
query parameters, and every request body on authentication endpoints."""
import re
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

SENSITIVE_HEADERS = {"authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization", "x-csrf-token",
                     "x-forwarded-for", "x-real-ip"}
_TOKEN_QS = re.compile(r"((?:token|code|password|secret|key|signature|sig)=)[^&]*", re.IGNORECASE)
AUTH_PATHS = ("/auth/", "/users/me/password", "/users/me/mfa", "/invitations/")
FILTERED = "[Filtered]"


def scrub_event(event: dict[str, Any], hint: dict | None = None) -> dict[str, Any]:
    request = event.get("request") or {}
    headers = request.get("headers")
    if isinstance(headers, dict):
        request["headers"] = {k: (FILTERED if k.lower() in SENSITIVE_HEADERS else v) for k, v in headers.items()}
    elif isinstance(headers, list):
        request["headers"] = [[k, FILTERED if str(k).lower() in SENSITIVE_HEADERS else v] for k, v in headers]
    request.pop("cookies", None)
    if isinstance(request.get("query_string"), str):
        request["query_string"] = _TOKEN_QS.sub(rf"\1{FILTERED}", request["query_string"])
    url = request.get("url") or ""
    if any(p in url for p in AUTH_PATHS) or "data" in request:
        request.pop("data", None)  # bodies are never sent; auth endpoints doubly so
    if request:
        event["request"] = request
    user = event.get("user")
    if isinstance(user, dict):
        event["user"] = {k: v for k, v in user.items() if k == "id"}
    return event


def init_error_reporting() -> bool:
    if not settings.SENTRY_DSN:
        return False
    try:
        import sentry_sdk
    except ImportError:
        log.warning("sentry_sdk_not_installed")
        return False
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        environment=settings.ENVIRONMENT,
        release=settings.SENTRY_RELEASE or "signalcraft-backend@0.1.0",
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
        before_send=scrub_event,
        before_send_transaction=scrub_event,
    )
    sentry_sdk.set_tag("service", "backend")
    return True

"""Structured logging with redaction of sensitive fields."""
import logging
import sys

import structlog

SENSITIVE_KEYS = {
    "password", "new_password", "current_password", "token", "access_token", "refresh_token",
    "authorization", "cookie", "secret", "api_key", "apikey", "client_secret", "auth_token",
    "password_hash", "credentials",
}


def _redact(_, __, event_dict):
    for key in list(event_dict.keys()):
        if key.lower() in SENSITIVE_KEYS:
            event_dict[key] = "[REDACTED]"
    return event_dict


def configure_logging(level: str = "INFO", json_logs: bool = False) -> None:
    lvl = getattr(logging, level.upper(), logging.INFO)
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=lvl)
    renderer = structlog.processors.JSONRenderer() if json_logs else structlog.dev.ConsoleRenderer(colors=False)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            _redact,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(lvl),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None):
    return structlog.get_logger(name)

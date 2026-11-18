"""Fixed-window rate limiting backed by Redis, with an in-memory fallback."""
import threading
import time

from fastapi import Request

from app.core.config import settings
from app.core.errors import RateLimited
from app.core.logging import get_logger

log = get_logger(__name__)


class _MemoryBackend:
    def __init__(self):
        self._data: dict[str, int] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, window: int) -> int:
        with self._lock:
            self._data[key] = self._data.get(key, 0) + 1
            if len(self._data) > 50_000:  # bound memory; keys embed the window bucket
                self._data.clear()
            return self._data[key]

    def reset(self):
        with self._lock:
            self._data.clear()


class _RedisBackend:
    def __init__(self, url: str):
        import redis

        self._r = redis.Redis.from_url(url, socket_connect_timeout=0.5, socket_timeout=0.5)
        self._r.ping()

    def hit(self, key: str, window: int) -> int:
        pipe = self._r.pipeline()
        pipe.incr(key)
        pipe.expire(key, window)
        return int(pipe.execute()[0])

    def reset(self):
        pass


_backend = None


def _get_backend():
    global _backend
    if _backend is None:
        if settings.ENVIRONMENT == "test" or settings.CELERY_TASK_ALWAYS_EAGER:
            _backend = _MemoryBackend()
        else:
            try:
                _backend = _RedisBackend(settings.REDIS_URL)
            except Exception:
                log.warning("rate_limit_redis_unavailable_using_memory")
                _backend = _MemoryBackend()
    return _backend


def reset_rate_limits() -> None:
    _get_backend().reset()


def client_ip(request: Request) -> str:
    # Only the first hop is used; deploy behind a proxy that overwrites X-Forwarded-For.
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(scope: str, limit: int | None = None, window_seconds: int = 60):
    """FastAPI dependency factory limiting requests per client IP within a scope."""

    def _dep(request: Request) -> None:
        if not settings.RATE_LIMIT_ENABLED:
            return
        max_hits = limit or settings.RATE_LIMIT_AUTH_PER_MINUTE
        bucket = int(time.time() // window_seconds)
        key = f"rl:{scope}:{client_ip(request)}:{bucket}"
        if _get_backend().hit(key, window_seconds) > max_hits:
            raise RateLimited("Too many requests. Please try again shortly.")

    return _dep

"""FastAPI application factory."""
import time
import uuid

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import settings
from app.core.errors import register_error_handlers
from app.core.logging import configure_logging, get_logger

log = get_logger("http")


def _start_local_scheduler() -> None:
    """Without Celery Beat (docker-less development), check for due scheduled campaigns and deferred
    SMS (quiet hours, retries) every 20 seconds."""
    import threading

    def loop():
        import time as _t

        from app.services.automation.engine import tick as automation_tick
        from app.services.billing.wallet import run_settlement
        from app.services.email.engine import dispatch_due
        from app.services.sms.engine import dispatch_due as dispatch_due_sms
        from app.services.voice.engine import dispatch_due as dispatch_due_voice

        while True:
            try:
                dispatch_due()
                dispatch_due_sms()
                dispatch_due_voice()
                automation_tick()
                run_settlement()
            except Exception:
                log.exception("local_scheduler_error")
            _t.sleep(20)

    threading.Thread(target=loop, daemon=True, name="local-scheduler").start()


def _init_error_reporting() -> None:
    """Send unhandled errors to Sentry when SENTRY_DSN is set and sentry-sdk is installed.
    Request bodies and personal data are not sent."""
    if not settings.SENTRY_DSN:
        return
    try:
        import sentry_sdk
    except ImportError:
        log.warning("sentry_sdk_not_installed")
        return
    sentry_sdk.init(dsn=settings.SENTRY_DSN, environment=settings.ENVIRONMENT, send_default_pii=False,
                    max_request_body_size="never", traces_sample_rate=0.0)


def create_app() -> FastAPI:
    configure_logging(settings.LOG_LEVEL, settings.LOG_JSON)
    _init_error_reporting()
    app = FastAPI(
        title=f"{settings.APP_NAME} API",
        version="0.1.0",
        description="Multi-tenant marketing automation platform. All tenant data lives under an application "
                    "the caller must be a member of. Errors use the envelope "
                    '`{"error": {"code", "message", "details", "request_id"}}`.',
        openapi_url=f"{settings.API_V1_PREFIX}/openapi.json",
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID", "Idempotency-Key"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id[:64]
        structlog.contextvars.bind_contextvars(request_id=request.state.request_id)
        start = time.perf_counter()
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.clear_contextvars()
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        if request.url.path.startswith(settings.API_V1_PREFIX):
            response.headers.setdefault("Cache-Control", "no-store")
        elapsed = round((time.perf_counter() - start) * 1000, 1)
        if request.url.path.startswith(settings.API_V1_PREFIX):
            from app.core.metrics import observe, path_group

            observe(request.method, path_group(request.url.path), response.status_code, elapsed)
        log.info("request", method=request.method, path=request.url.path, status=response.status_code,
                 duration_ms=elapsed, request_id=request.state.request_id)
        return response

    @app.on_event("startup")
    def _resume_local_jobs():
        # Without Celery, jobs run in API threads and stop when the server restarts. Resume them.
        if settings.CELERY_TASK_ALWAYS_EAGER and settings.ENVIRONMENT == "development":
            try:
                from app.tasks.email import resume_sending_campaigns
                from app.tasks.imports import resume_stalled_imports
                from app.tasks.sms import resume_sms_campaigns
                from app.tasks.voice import resume_voice_campaigns

                resume_stalled_imports(stale_after_minutes=0)
                resume_sending_campaigns()
                resume_sms_campaigns()
                resume_voice_campaigns()
                _start_local_scheduler()
            except Exception:
                log.exception("resume_local_jobs_failed")

    register_error_handlers(app)
    app.include_router(api_router, prefix=settings.API_V1_PREFIX)
    return app


app = create_app()

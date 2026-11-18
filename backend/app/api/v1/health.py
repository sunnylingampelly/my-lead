import hmac
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy import func, select, text

from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.core.errors import NotFound, Unauthorized

router = APIRouter(tags=["Health"])


@router.get("/health/live")
def live():
    return {"status": "ok"}


@router.get("/health")
def health():
    """Readiness: database, queue and file storage."""
    checks: dict[str, str] = {}
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "error"
    if settings.CELERY_TASK_ALWAYS_EAGER:
        checks["queue"] = "eager"
    else:
        try:
            import redis

            redis.Redis.from_url(settings.REDIS_URL, socket_connect_timeout=0.5).ping()
            checks["queue"] = "ok"
        except Exception:
            checks["queue"] = "error"
    if settings.STORAGE_BACKEND == "local":
        p = Path(settings.LOCAL_STORAGE_PATH)
        try:
            p.mkdir(parents=True, exist_ok=True)
            probe = p / ".health"
            probe.write_text("ok")
            probe.unlink()
            checks["storage"] = "ok"
        except OSError:
            checks["storage"] = "error"
    healthy = all(v in ("ok", "eager") for v in checks.values())
    return JSONResponse(
        status_code=200 if healthy else 503,
        content={"status": "ok" if healthy else "degraded", "checks": checks,
                 "communication_mode": settings.COMMUNICATION_MODE, "environment": settings.ENVIRONMENT},
    )


@router.get("/metrics", include_in_schema=False)
def metrics(request: Request):
    """Prometheus text format. Disabled unless METRICS_TOKEN is set; requires it as a bearer token."""
    from app.core.metrics import render
    from app.models.automation import WorkflowRun
    from app.models.billing import WalletHold
    from app.models.email import EmailCampaign, EmailMessage, WebhookEvent
    from app.models.sms import SmsCampaign, SmsMessage
    from app.models.voice import VoiceCall, VoiceCampaign

    if not settings.METRICS_TOKEN:
        raise NotFound()
    got = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not hmac.compare_digest(got, settings.METRICS_TOKEN):
        raise Unauthorized("Invalid metrics token")
    g: dict[str, list] = {}
    with SessionLocal() as db:
        def by(model, col, *where):
            return list(db.execute(select(col, func.count()).select_from(model).where(*where).group_by(col)).all())

        g["signalcraft_campaigns"] = [({"channel": ch, "status": s}, n) for ch, model in
                                      (("email", EmailCampaign), ("sms", SmsCampaign), ("voice", VoiceCampaign))
                                      for s, n in by(model, model.status)]
        g["signalcraft_messages_pending"] = [
            ({"channel": "email"}, db.scalar(select(func.count()).select_from(EmailMessage).where(
                EmailMessage.status.in_(("queued", "sending")))) or 0),
            ({"channel": "sms"}, db.scalar(select(func.count()).select_from(SmsMessage).where(
                SmsMessage.status.in_(("queued", "deferred", "sending")))) or 0),
            ({"channel": "voice"}, db.scalar(select(func.count()).select_from(VoiceCall).where(
                VoiceCall.status.in_(("queued", "deferred", "placing", "dialing", "ringing", "in_progress")))) or 0)]
        g["signalcraft_webhook_events"] = [({"provider": p, "status": s}, n) for p, s, n in db.execute(
            select(WebhookEvent.provider, WebhookEvent.status, func.count()).group_by(WebhookEvent.provider,
                                                                                       WebhookEvent.status))]
        g["signalcraft_workflow_runs"] = [({"status": s}, n) for s, n in by(WorkflowRun, WorkflowRun.status)]
        g["signalcraft_wallet_holds_open"] = [({}, db.scalar(select(func.count()).select_from(WalletHold).where(
            WalletHold.status == "open")) or 0)]
    g["signalcraft_up"] = [({}, 1)]
    return PlainTextResponse(render(g), media_type="text/plain; version=0.0.4")

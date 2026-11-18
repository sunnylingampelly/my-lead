"""Provider callbacks for SMS: delivery receipts and inbound replies.

Every callback is authenticated (Twilio request signature, MSG91 shared token, or our own HMAC for
the simulator), stored once in webhook_events, and processed in the background.
"""
import hmac
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select

from app.api.deps import DB
from app.api.v1.public_email import simulation_signature
from app.core.config import settings
from app.core.errors import NotFound, Unauthorized
from app.models.email import WebhookEvent
from app.providers.sms.twilio import verify_twilio
from app.services.email.render import public_url

router = APIRouter(tags=["Public SMS"])
EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'


def _store(db, provider: str, event_id: str, event_type: str, payload: dict) -> None:
    if not event_id or db.scalar(select(WebhookEvent.id).where(WebhookEvent.provider == provider,
                                                               WebhookEvent.event_id == event_id[:255])):
        return
    w = WebhookEvent(provider=provider, channel="sms", event_id=event_id[:255], event_type=event_type,
                     payload=payload, signature_valid=True)
    db.add(w)
    db.commit()
    from app.tasks.sms import process_sms_webhook
    from app.workers.dispatch import dispatch

    dispatch(process_sms_webhook, w.id)


async def _twilio_form(request: Request, path: str) -> dict[str, str]:
    if not settings.TWILIO_AUTH_TOKEN:
        raise NotFound()
    form = {k: str(v) for k, v in (await request.form()).items()}
    if not verify_twilio(settings.TWILIO_AUTH_TOKEN, public_url(path), form,
                         request.headers.get("x-twilio-signature", "")):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    return form


@router.post("/webhooks/sms/twilio/status", include_in_schema=False)
async def twilio_status(request: Request, db: DB):
    f = await _twilio_form(request, "/webhooks/sms/twilio/status")
    sid, st = f.get("MessageSid", ""), f.get("MessageStatus", "")
    item = {"message_id": sid, "status": st, "error_code": f.get("ErrorCode") or None}
    _store(db, "sms_twilio", f"{sid}:{st}", "status", item)
    return Response(status_code=204)


@router.post("/webhooks/sms/twilio/inbound", include_in_schema=False)
async def twilio_inbound(request: Request, db: DB):
    f = await _twilio_form(request, "/webhooks/sms/twilio/inbound")
    _store(db, "sms_twilio", f.get("MessageSid", ""), "inbound",
           {"from": f.get("From", ""), "to": f.get("To", ""), "body": f.get("Body", "")[:320]})
    return Response(content=EMPTY_TWIML, media_type="application/xml")


def _msg91_token(token: str) -> None:
    if not settings.MSG91_WEBHOOK_TOKEN:
        raise NotFound()
    if not hmac.compare_digest(token, settings.MSG91_WEBHOOK_TOKEN):
        raise Unauthorized("Invalid token", code="INVALID_SIGNATURE")


@router.post("/webhooks/sms/msg91", include_in_schema=False)
async def msg91_report(request: Request, db: DB, token: str = ""):
    """MSG91 delivery reports. Accepts a list (or {"data": [...]}) of objects with requestId and status.
    The field names follow MSG91's documented DLR push format; confirm them for your account."""
    _msg91_token(token)
    try:
        payload = json.loads(await request.body())
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    items = payload.get("data", []) if isinstance(payload, dict) else payload
    for it in items if isinstance(items, list) else []:
        rid = str(it.get("requestId") or it.get("request_id") or "")
        reports = it.get("report") or [it]
        for r in reports:
            st = str(r.get("status", ""))
            item = {"message_id": rid, "status": st, "error_code": r.get("desc") if st != "1" else None}
            _store(db, "sms_msg91", f"{rid}:{r.get('number', '')}:{st}", "status", item)
    return {"received": True}


@router.post("/webhooks/sms/msg91/inbound", include_in_schema=False)
async def msg91_inbound(request: Request, db: DB, token: str = ""):
    _msg91_token(token)
    try:
        p = json.loads(await request.body())
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    sender = str(p.get("to") or p.get("sender") or "")
    mobile = str(p.get("mobile") or p.get("from") or "")
    if mobile and not mobile.startswith("+"):
        mobile = "+" + mobile
    _store(db, "sms_msg91", str(p.get("id") or p.get("requestId") or f"{mobile}:{p.get('date', '')}"), "inbound",
           {"from": mobile, "to": sender, "body": str(p.get("message") or p.get("content") or "")[:320]})
    return {"received": True}


@router.post("/webhooks/sms/simulation", include_in_schema=False)
async def simulation_hook(request: Request, db: DB):
    """Signed test hook for simulated receipts and replies (development and automated tests)."""
    if settings.ENVIRONMENT == "production":
        raise NotFound()
    body = await request.body()
    if not hmac.compare_digest(request.headers.get("x-signature", ""), simulation_signature(body)):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    p = json.loads(body)
    _store(db, "sms_simulation", p["event_id"], p.get("kind", "status"), p)
    return {"received": True}

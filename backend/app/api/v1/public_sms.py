"""Provider callbacks for SMS: inbound replies from Amazon SNS, and the signed simulator hook.

Delivery receipts for SNS are not callbacks; they are read from SNS delivery status logs
(app.services.sms.sns_receipts). Replies such as STOP reach us through two-way SMS in AWS End User
Messaging, which publishes each inbound message to an SNS topic subscribed to /webhooks/sms/sns.
Every event is authenticated, stored once in webhook_events, and processed in the background.
"""
import hmac
import json

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.api.deps import DB
from app.api.v1.public_email import simulation_signature
from app.core.config import settings
from app.core.errors import NotFound, Unauthorized
from app.services.sms.webhooks import store_event

router = APIRouter(tags=["Public SMS"])


def parse_sns_inbound(msg: dict) -> dict | None:
    """The inner message of an SNS notification for two-way SMS -> {from, to, body, id}."""
    try:
        inner = json.loads(msg.get("Message") or "")
    except ValueError:
        return None
    if not isinstance(inner, dict) or not inner.get("originationNumber"):
        return None
    return {"from": str(inner["originationNumber"]), "to": str(inner.get("destinationNumber") or ""),
            "body": str(inner.get("messageBody") or "")[:320],
            "id": str(inner.get("inboundMessageId") or msg.get("MessageId") or "")}


@router.post("/webhooks/sms/sns", include_in_schema=False)
async def sns_inbound(request: Request, db: DB):
    from app.providers.email.webhooks import WebhookError, verify_sns

    try:
        msg = json.loads(await request.body())
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    if settings.SES_VERIFY_SNS_SIGNATURES:
        try:
            verify_sns(msg)
        except WebhookError:
            raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE") from None
    if msg.get("Type") == "SubscriptionConfirmation":
        # Confirming subscribes this endpoint to the topic; only after a valid signature.
        url = msg.get("SubscribeURL", "")
        if url.startswith("https://sns.") and ".amazonaws.com/" in url:
            httpx.get(url, timeout=10)
        return {"confirmed": True}
    item = parse_sns_inbound(msg) if msg.get("Type") == "Notification" else None
    if item is None:
        return {"received": True, "ignored": True}
    store_event(db, "sms_sns", item["id"], "inbound", {"from": item["from"], "to": item["to"], "body": item["body"]})
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
    store_event(db, "sms_simulation", p["event_id"], p.get("kind", "status"), p)
    return {"received": True}

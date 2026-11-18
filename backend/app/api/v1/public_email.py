"""Public, unauthenticated email endpoints: tracking, unsubscribe and sender confirmation.

Every link carries an HMAC-signed token, so nothing here can be guessed or replayed for another
purpose. Click redirects only go to URLs frozen into the campaign at launch (no open redirect).
"""
import base64
import hashlib
import hmac
import json

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse, RedirectResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB
from app.core.config import settings
from app.core.errors import NotFound, Unauthorized
from app.core.rate_limit import rate_limit
from app.models import Application, ApplicationSettings, Organization
from app.models.email import EmailCampaign, EmailMessage, WebhookEvent
from app.services.email import events, senders, tokens
from app.utils.contact_normalize import mask_email

router = APIRouter(tags=["Public email"])
PIXEL = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
NO_STORE = {"Cache-Control": "no-store, no-cache, must-revalidate, private", "Pragma": "no-cache"}


def _message(db, purpose: str, token: str) -> EmailMessage | None:
    mid = tokens.read(purpose, token)
    return db.get(EmailMessage, mid) if mid else None


def _ua_class(request: Request) -> str:
    ua = (request.headers.get("user-agent") or "").lower()
    if "googleimageproxy" in ua:
        return "gmail_proxy"
    if "yahoo" in ua and "proxy" in ua:
        return "yahoo_proxy"
    if "mozilla" in ua and "applewebkit" in ua and "mobile" not in ua and "safari" not in ua:
        return "apple_mail"  # often Apple Mail Privacy Protection prefetch
    return "client"


@router.get("/t/o/{token}.gif", include_in_schema=False)
def track_open(token: str, request: Request, db: DB):
    msg = _message(db, "o", token)
    if msg is not None:
        events.apply(db, msg, "opened", provider="tracking", meta={"agent": _ua_class(request)})
        db.commit()
    return Response(content=PIXEL, media_type="image/gif", headers=NO_STORE)


@router.get("/t/c/{token}/{index}", include_in_schema=False)
def track_click(token: str, index: int, db: DB):
    msg = _message(db, "c", token)
    if msg is None:
        raise NotFound("Link not found")
    campaign = db.get(EmailCampaign, msg.campaign_id)
    links = campaign.links if campaign else []
    if not 0 <= index < len(links):
        raise NotFound("Link not found")
    url = links[index]
    events.apply(db, msg, "clicked", provider="tracking", url=url)
    db.commit()
    return RedirectResponse(url, status_code=status.HTTP_302_FOUND, headers=NO_STORE)


class TokenBody(BaseModel):
    token: str = Field(min_length=10, max_length=200)


def _unsubscribe_info(db, msg: EmailMessage) -> dict:
    app = db.get(Application, msg.application_id)
    org = db.get(Organization, msg.organization_id)
    s = db.scalar(select(ApplicationSettings).where(ApplicationSettings.application_id == msg.application_id))
    return {"sender": (s.business_name if s and s.business_name else (org.name if org else "")),
            "application": app.name if app else "", "email": mask_email(msg.to_email),
            "unsubscribed": msg.unsubscribed_at is not None}


@router.get("/public/unsubscribe/{token}", dependencies=[Depends(rate_limit("unsub", 60))])
def unsubscribe_info(token: str, db: DB):
    msg = _message(db, "u", token)
    if msg is None:
        raise NotFound("This unsubscribe link is not valid")
    return _unsubscribe_info(db, msg)


@router.post("/public/unsubscribe", dependencies=[Depends(rate_limit("unsub", 60))])
def unsubscribe(body: TokenBody, db: DB):
    msg = _message(db, "u", body.token)
    if msg is None:
        raise NotFound("This unsubscribe link is not valid")
    events.apply(db, msg, "unsubscribed", provider="unsubscribe_page")
    db.commit()
    return _unsubscribe_info(db, msg)


@router.post("/u/{token}", include_in_schema=False)
def one_click_unsubscribe(token: str, db: DB):
    """RFC 8058 List-Unsubscribe-Post target used by Gmail, Yahoo and others."""
    msg = _message(db, "u", token)
    if msg is not None:
        events.apply(db, msg, "unsubscribed", provider="list_unsubscribe")
        db.commit()
    return Response(status_code=200)


@router.post("/public/email-senders/verify", dependencies=[Depends(rate_limit("sender_verify", 30))])
def verify_sender(body: TokenBody, db: DB):
    s = senders.verify(db, body.token)
    db.commit()
    return {"from_email": s.from_email, "status": s.status}


# ------------------------------------------------------------------ provider webhooks

def _store(db, provider: str, event_id: str, event_type: str | None, payload: dict, valid: bool) -> str | None:
    if db.scalar(select(WebhookEvent.id).where(WebhookEvent.provider == provider, WebhookEvent.event_id == event_id)):
        return None  # duplicate delivery from the provider
    w = WebhookEvent(provider=provider, event_id=event_id[:255], event_type=event_type, payload=payload,
                     signature_valid=valid)
    db.add(w)
    db.commit()
    return w.id


def _queue(webhook_id: str | None) -> None:
    if webhook_id:
        from app.tasks.email import process_webhook_event
        from app.workers.dispatch import dispatch

        dispatch(process_webhook_event, webhook_id)


@router.post("/webhooks/email/ses", include_in_schema=False)
async def ses_webhook(request: Request, db: DB):
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
        import httpx

        url = msg.get("SubscribeURL", "")
        if url.startswith("https://sns.") and ".amazonaws.com/" in url:
            httpx.get(url, timeout=10)
        return {"confirmed": True}
    wid = _store(db, "ses", msg.get("MessageId", ""), msg.get("Type"), msg, True)
    _queue(wid)
    return {"received": True}


@router.post("/webhooks/email/brevo", include_in_schema=False)
async def brevo_webhook(request: Request, db: DB, token: str = ""):
    if not settings.BREVO_WEBHOOK_TOKEN:
        return JSONResponse({"error": "webhook not configured"}, status_code=503)
    if not hmac.compare_digest(token, settings.BREVO_WEBHOOK_TOKEN):
        raise Unauthorized("Invalid token", code="INVALID_SIGNATURE")
    try:
        payload = json.loads(await request.body())
    except ValueError:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    from app.providers.email.webhooks import parse_brevo

    items = payload if isinstance(payload, list) else [payload]
    for p in items:
        parsed = parse_brevo(p)
        if parsed:
            _queue(_store(db, "brevo", parsed[0].event_id, p.get("event"), p, True))
    return {"received": True}


def simulation_signature(body: bytes) -> str:
    key = hashlib.sha256(f"sim-webhook:{settings.SECRET_KEY}".encode()).digest()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


@router.post("/webhooks/email/simulation", include_in_schema=False)
async def simulation_webhook(request: Request, db: DB):
    """Signed test hook for simulated provider events (development and automated tests)."""
    if settings.ENVIRONMENT == "production":
        raise NotFound()
    body = await request.body()
    if not hmac.compare_digest(request.headers.get("x-signature", ""), simulation_signature(body)):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    p = json.loads(body)
    _queue(_store(db, "simulation", p["event_id"], p.get("type"), p, True))
    return {"received": True}

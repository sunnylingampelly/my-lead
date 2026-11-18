"""Public voice endpoints: recordings and scripts fetched by providers, keypresses, and status callbacks.

Recording, script and keypress URLs carry HMAC-signed tokens bound to one call or recording.
Status callbacks are authenticated by the Twilio request signature, an Exotel shared token,
or our own HMAC for the simulator, then stored once and processed in the background.
"""
import hmac
import json
from xml.sax.saxutils import escape

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse, Response
from sqlalchemy import select

from app.api.deps import DB
from app.api.v1.public_email import simulation_signature
from app.core.config import settings
from app.core.errors import NotFound, Unauthorized
from app.models import Contact
from app.models.email import WebhookEvent
from app.models.voice import VoiceCall, VoiceCampaign
from app.providers.sms.twilio import verify_twilio
from app.services.email import tokens
from app.services.email.render import public_url
from app.services.voice import events, library, rules, script

router = APIRouter(tags=["Public voice"])
NO_STORE = {"Cache-Control": "no-store, private"}


@router.get("/public/voice/audio/{token}", include_in_schema=False)
def audio(token: str, db: DB):
    found = library.read_audio(db, token)
    if found is None:
        raise NotFound("Recording not found")
    data, content_type = found
    return Response(content=data, media_type=content_type, headers=NO_STORE)


@router.get("/public/voice/script/{token}", include_in_schema=False)
def call_script(token: str, db: DB):
    """Plain-text script for providers that fetch call content (Exotel dynamic greeting)."""
    cid = tokens.read("vs", token)
    call = db.get(VoiceCall, cid) if cid else None
    if call is None:
        raise NotFound()
    campaign = db.get(VoiceCampaign, call.campaign_id)
    contact = db.get(Contact, call.contact_id) if call.contact_id else None
    sc = script.build(campaign.snapshot or {}, contact, call.id)
    lines = [s.text if s.kind == "say" else s.url for s in sc.steps]
    if sc.gather_prompt:
        lines.append(sc.gather_prompt.text)
    return PlainTextResponse("\n".join(x for x in lines if x), headers=NO_STORE)


@router.post("/public/voice/keypress/{token}", include_in_schema=False)
async def keypress(token: str, request: Request, db: DB):
    cid = tokens.read("vk", token)
    call = db.get(VoiceCall, cid) if cid else None
    if call is None:
        raise NotFound()
    form = await request.form()
    digits = str(form.get("Digits") or form.get("digits") or "")[:10]
    if digits:
        events.apply(db, call, "keypress", provider=call.provider,
                     provider_event_id=f"{call.provider_call_id}:keypress:{digits}", digits=digits)
        db.commit()
    lang = ((db.get(VoiceCampaign, call.campaign_id).snapshot or {}).get("language")) or "en-US"
    msg = "You will not receive further calls from us. Goodbye." if digits == rules.OPT_OUT_DIGIT else "Goodbye."
    return Response(content=f'<?xml version="1.0" encoding="UTF-8"?><Response><Say language="{escape(lang)}">'
                            f"{escape(msg)}</Say><Hangup/></Response>", media_type="application/xml")


def _store(db, provider: str, event_id: str, payload: dict) -> None:
    if not event_id or db.scalar(select(WebhookEvent.id).where(WebhookEvent.provider == provider,
                                                               WebhookEvent.event_id == event_id[:255])):
        return
    w = WebhookEvent(provider=provider, channel="voice", event_id=event_id[:255], event_type="status",
                     payload=payload, signature_valid=True)
    db.add(w)
    db.commit()
    from app.tasks.voice import process_voice_webhook
    from app.workers.dispatch import dispatch

    dispatch(process_voice_webhook, w.id)


@router.post("/webhooks/voice/twilio/status", include_in_schema=False)
async def twilio_status(request: Request, db: DB):
    if not settings.TWILIO_AUTH_TOKEN:
        raise NotFound()
    f = {k: str(v) for k, v in (await request.form()).items()}
    if not verify_twilio(settings.TWILIO_AUTH_TOKEN, public_url("/webhooks/voice/twilio/status"), f,
                         request.headers.get("x-twilio-signature", "")):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    sid, st = f.get("CallSid", ""), f.get("CallStatus", "")
    _store(db, "voice_twilio", f"{sid}:{st}", {"call_id": sid, "status": st, "duration": f.get("CallDuration"),
                                               "answered_by": f.get("AnsweredBy"),
                                               "error_code": f.get("ErrorCode") or None})
    return Response(status_code=204)


@router.post("/webhooks/voice/telnyx/status/{token}/{attempt}", include_in_schema=False)
async def telnyx_status(token: str, attempt: int, request: Request, db: DB):
    """TeXML status callback. Authenticated by the signed per-call token and, when the account public
    key is configured, by Telnyx's Ed25519 signature over the raw body."""
    from app.providers.voice.telnyx import verify_signature

    call_id = tokens.read("vt", token)
    if call_id is None:
        raise NotFound()
    body = await request.body()
    if settings.TELNYX_PUBLIC_KEY and not verify_signature(
            settings.TELNYX_PUBLIC_KEY, request.headers.get("telnyx-signature-ed25519", ""),
            request.headers.get("telnyx-timestamp", ""), body):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    ct = request.headers.get("content-type", "")
    if "json" in ct:
        f = json.loads(body or b"{}")
    else:
        from urllib.parse import parse_qsl

        f = dict(parse_qsl(body.decode()))
    st = str(f.get("CallStatus") or f.get("call_status") or "")
    _store(db, "voice_telnyx", f"{call_id}:{attempt}:{st}",
           {"call_ref": call_id, "attempt": attempt, "call_id": f.get("CallSid") or f.get("call_sid"), "status": st,
            "duration": f.get("CallDuration") or f.get("call_duration"), "answered_by": f.get("AnsweredBy")})
    return Response(status_code=204)


@router.post("/webhooks/voice/exotel/status", include_in_schema=False)
async def exotel_status(request: Request, db: DB, token: str = ""):
    if not settings.EXOTEL_WEBHOOK_TOKEN:
        raise NotFound()
    if not hmac.compare_digest(token, settings.EXOTEL_WEBHOOK_TOKEN):
        raise Unauthorized("Invalid token", code="INVALID_SIGNATURE")
    ct = request.headers.get("content-type", "")
    f = json.loads(await request.body()) if "json" in ct else {k: str(v) for k, v in (await request.form()).items()}
    sid, st = str(f.get("CallSid", "")), str(f.get("Status", ""))
    _store(db, "voice_exotel", f"{sid}:{st}", {"call_id": sid, "status": st,
                                               "duration": str(f.get("ConversationDuration") or f.get("Duration") or "")})
    return {"received": True}


@router.post("/webhooks/voice/simulation", include_in_schema=False)
async def simulation_hook(request: Request, db: DB):
    """Signed test hook for simulated call events (development and automated tests)."""
    if settings.ENVIRONMENT == "production":
        raise NotFound()
    body = await request.body()
    if not hmac.compare_digest(request.headers.get("x-signature", ""), simulation_signature(body)):
        raise Unauthorized("Invalid signature", code="INVALID_SIGNATURE")
    p = json.loads(body)
    _store(db, "voice_simulation", p["event_id"], p)
    return {"received": True}

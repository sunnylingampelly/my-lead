"""Telnyx voice adapter (TeXML).

Calls are placed with POST /v2/texml/Accounts/{account_sid}/Calls and inline TeXML, which uses the
same verbs as TwiML (<Say>, <Play>, <Gather>), so the script is built by the shared TwiML builder.
Status callbacks carry a signed per-call token in the URL; when TELNYX_PUBLIC_KEY is set they must
also carry a valid Ed25519 signature (telnyx-signature-ed25519 over "{timestamp}|{raw body}").

The request format follows Telnyx's published API reference. It has not been exercised against the
live service from this codebase; place a test call before running a campaign.
"""
import base64
import time

import httpx

from app.providers.voice.base import CallResult, OutboundCall, TransientVoiceError, VoiceProvider
from app.providers.voice.twilio import twiml

API = "https://api.telnyx.com/v2"


class TelnyxVoiceProvider(VoiceProvider):
    name = "telnyx"

    def __init__(self, api_key: str, account_sid: str, application_sid: str, timeout: float = 15.0):
        if not (api_key and account_sid and application_sid):
            raise ValueError("Telnyx API key, account id and TeXML application id are required")
        self._key, self._account, self._app, self._timeout = api_key, account_sid, application_sid, timeout

    def place(self, call: OutboundCall) -> CallResult:
        if call.script.relay is not None:
            return CallResult(accepted=False, provider=self.name, error_code="AI_UNSUPPORTED",
                              error_message="AI agents need the Twilio provider for live calls")
        body = {"To": call.to, "From": call.caller_id, "ApplicationSid": self._app, "Texml": twiml(call.script),
                "Timeout": 30}
        if call.machine_detection:
            body["MachineDetection"] = "Enable"
        if call.status_callback:
            body["StatusCallback"] = call.status_callback
            body["StatusCallbackMethod"] = "POST"
            body["StatusCallbackEvent"] = "initiated ringing answered completed"
        try:
            r = httpx.post(f"{API}/texml/Accounts/{self._account}/Calls", json=body,
                           headers={"Authorization": f"Bearer {self._key}"}, timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise TransientVoiceError(f"telnyx network error: {type(exc).__name__}") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientVoiceError(f"telnyx status {r.status_code}")
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code >= 400:
            err = (data.get("errors") or [{}])[0]
            return CallResult(accepted=False, provider=self.name, error_code=str(err.get("code") or r.status_code),
                              error_message=str(err.get("detail") or err.get("title") or "Rejected")[:500])
        sid = data.get("call_sid") or data.get("sid") or (data.get("data") or {}).get("call_sid")
        # Callbacks are matched by the signed token in the callback URL, so a missing SID is fine.
        return CallResult(accepted=True, provider=self.name, provider_call_id=sid or call.idempotency_key)


def list_numbers(api_key: str, timeout: float = 15.0) -> list[dict]:
    """Phone numbers on the Telnyx account, to pick a caller ID from."""
    r = httpx.get(f"{API}/phone_numbers", params={"page[size]": 100, "filter[status]": "active"},
                  headers={"Authorization": f"Bearer {api_key}"}, timeout=timeout)
    r.raise_for_status()
    return [{"number": n.get("phone_number"), "label": n.get("connection_name") or n.get("tags", [None])[0]
             if n.get("tags") else n.get("connection_name")} for n in r.json().get("data", [])]


def verify_signature(public_key_b64: str, signature_b64: str, timestamp: str, body: bytes,
                     tolerance: int = 300) -> bool:
    """Ed25519 check of "{timestamp}|{raw body}" with replay protection."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        if abs(time.time() - int(timestamp)) > tolerance:
            return False
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64))
        key.verify(base64.b64decode(signature_b64), timestamp.encode() + b"|" + body)
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False

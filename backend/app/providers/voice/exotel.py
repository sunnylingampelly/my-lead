"""Exotel adapter for India.

Exotel plays call content through a call flow (app) configured in the Exotel dashboard. Configure
EXOTEL_APP_ID with a flow whose Greeting/Passthru applet fetches our per-call script URL
(passed as CustomField). The request format follows Exotel's v1 Calls/connect API; verify it
against your account before enabling live calling. This adapter has not been exercised against
the live service.
"""
import httpx

from app.providers.voice.base import CallResult, OutboundCall, TransientVoiceError, VoiceProvider


class ExotelVoiceProvider(VoiceProvider):
    name = "exotel"

    def __init__(self, sid: str, api_key: str, api_token: str, subdomain: str, app_id: str, timeout: float = 15.0):
        if not (sid and api_key and api_token and app_id):
            raise ValueError("Exotel credentials and call flow are required")
        self._sid, self._key, self._token, self._sub, self._app = sid, api_key, api_token, subdomain, app_id
        self._timeout = timeout

    def place(self, call: OutboundCall) -> CallResult:
        if call.script.relay is not None:
            return CallResult(accepted=False, provider=self.name, error_code="AI_UNSUPPORTED",
                              error_message="AI agents need the Twilio provider for live calls")
        data = {
            "From": call.to,
            "CallerId": call.caller_id,
            "Url": f"http://my.exotel.com/{self._sid}/exoml/start_voice/{self._app}",
            "CallType": "trans",
            "CustomField": call.script_url or "",
        }
        if call.status_callback:
            data["StatusCallback"] = call.status_callback
        try:
            r = httpx.post(f"https://{self._sub}/v1/Accounts/{self._sid}/Calls/connect.json", data=data,
                           auth=(self._key, self._token), timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise TransientVoiceError(f"exotel network error: {type(exc).__name__}") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientVoiceError(f"exotel status {r.status_code}")
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400:
            err = (body.get("RestException") or {})
            return CallResult(accepted=False, provider=self.name, error_code=str(err.get("Code") or r.status_code),
                              error_message=str(err.get("Message") or "Rejected")[:500])
        return CallResult(accepted=True, provider=self.name, provider_call_id=(body.get("Call") or {}).get("Sid"))

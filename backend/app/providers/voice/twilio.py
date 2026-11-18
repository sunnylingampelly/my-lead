"""Twilio Programmable Voice adapter. The call script is sent inline as TwiML; callbacks are
validated with the same X-Twilio-Signature scheme as SMS (see providers.sms.twilio)."""
from xml.sax.saxutils import escape, quoteattr

import httpx

from app.providers.voice.base import CallResult, CallScript, OutboundCall, TransientVoiceError, VoiceProvider

# Polly neural voices Twilio supports for <Say>, by language and gender.
VOICES = {
    ("en-IN", "female"): "Polly.Kajal-Neural", ("en-IN", "male"): "Polly.Kajal-Neural",
    ("hi-IN", "female"): "Polly.Kajal-Neural", ("hi-IN", "male"): "Polly.Kajal-Neural",
    ("en-US", "female"): "Polly.Joanna-Neural", ("en-US", "male"): "Polly.Matthew-Neural",
    ("es-US", "female"): "Polly.Lupe-Neural", ("es-US", "male"): "Polly.Pedro-Neural",
}


def _say(text: str, language: str | None, voice: str | None) -> str:
    v = VOICES.get((language or "en-US", voice or "female"))
    attrs = f" language={quoteattr(language)}" if language else ""
    attrs += f" voice={quoteattr(v)}" if v else ""
    return f"<Say{attrs}>{escape(text)}</Say>"


def twiml(script: CallScript) -> str:
    parts = []
    for s in script.steps:
        parts.append(_say(s.text or "", s.language, s.voice) if s.kind == "say" else f"<Play>{escape(s.url or '')}</Play>")
    if script.gather_digit_url and script.gather_prompt:
        p = script.gather_prompt
        parts.append(f'<Gather numDigits="1" timeout="5" action={quoteattr(script.gather_digit_url)} method="POST">'
                     f"{_say(p.text or '', p.language, p.voice)}</Gather>")
    return f'<?xml version="1.0" encoding="UTF-8"?><Response>{"".join(parts)}</Response>'


class TwilioVoiceProvider(VoiceProvider):
    name = "twilio"

    def __init__(self, account_sid: str, auth_token: str, timeout: float = 15.0):
        if not account_sid or not auth_token:
            raise ValueError("Twilio credentials are required")
        self._sid, self._token, self._timeout = account_sid, auth_token, timeout

    def place(self, call: OutboundCall) -> CallResult:
        data = {"To": call.to, "From": call.caller_id, "Twiml": twiml(call.script)}
        if call.machine_detection:
            data["MachineDetection"] = "Enable"
        if call.status_callback:
            data["StatusCallback"] = call.status_callback
            data["StatusCallbackMethod"] = "POST"
            data["StatusCallbackEvent"] = "initiated ringing answered completed"
        try:
            r = httpx.post(f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Calls.json", data=data,
                           auth=(self._sid, self._token), timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise TransientVoiceError(f"twilio network error: {type(exc).__name__}") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientVoiceError(f"twilio status {r.status_code}")
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code >= 400:
            return CallResult(accepted=False, provider=self.name, error_code=str(body.get("code") or r.status_code),
                              error_message=str(body.get("message") or "Rejected")[:500])
        return CallResult(accepted=True, provider=self.name, provider_call_id=body.get("sid"))

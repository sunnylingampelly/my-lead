"""Twilio Programmable Voice adapter. The call script is sent inline as TwiML; callbacks are
validated with the X-Twilio-Signature scheme (twilio_signature / verify_twilio below)."""
import base64
import hashlib
import hmac
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


# Amazon Polly neural voices for ConversationRelay (ttsProvider="Amazon").
RELAY_VOICES = {k: v.removeprefix("Polly.") for k, v in VOICES.items()}


def relay_twiml(script: CallScript) -> str:
    """<Connect><ConversationRelay>: Twilio speaks, transcribes and talks to our WebSocket."""
    r = script.relay
    voice = RELAY_VOICES.get((r.language, r.voice or "female"))
    attrs = [f"url={quoteattr(r.url)}", f"welcomeGreeting={quoteattr(r.greeting)}", f"language={quoteattr(r.language)}"]
    if voice:
        attrs += ['ttsProvider="Amazon"', f"voice={quoteattr(voice)}"]
    attrs += ['dtmfDetection="true"', 'interruptible="any"', 'welcomeGreetingInterruptible="any"']
    action = f" action={quoteattr(r.action_url)}" if r.action_url else ""
    return (f'<?xml version="1.0" encoding="UTF-8"?><Response><Connect{action}>'
            f'<ConversationRelay {" ".join(attrs)}/></Connect></Response>')


def twiml(script: CallScript) -> str:
    if script.relay is not None:
        return relay_twiml(script)
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


def twilio_signature(auth_token: str, url: str, params: dict[str, str]) -> str:
    payload = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()).decode()


def verify_twilio(auth_token: str, url: str, params: dict[str, str], signature: str) -> bool:
    return bool(signature) and hmac.compare_digest(twilio_signature(auth_token, url, params), signature)

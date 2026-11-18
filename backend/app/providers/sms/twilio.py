"""Twilio Programmable Messaging adapter, with request signature validation for callbacks."""
import base64
import hashlib
import hmac

import httpx

from app.providers.sms.base import OutboundSms, SmsProvider, SmsResult, TransientSmsError

# Twilio errors that will never succeed on retry for this recipient.
PERMANENT = {"21211", "21214", "21408", "21610", "21612", "21614", "21608", "30006", "30007"}


class TwilioSmsProvider(SmsProvider):
    name = "twilio"

    def __init__(self, account_sid: str, auth_token: str, timeout: float = 15.0):
        if not account_sid or not auth_token:
            raise ValueError("Twilio credentials are required")
        self._sid, self._token, self._timeout = account_sid, auth_token, timeout

    def send(self, message: OutboundSms) -> SmsResult:
        data = {"To": message.to, "Body": message.body}
        if message.messaging_service_sid:
            data["MessagingServiceSid"] = message.messaging_service_sid
        else:
            data["From"] = message.sender_id
        if message.status_callback:
            data["StatusCallback"] = message.status_callback
        try:
            r = httpx.post(f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Messages.json", data=data,
                           auth=(self._sid, self._token), timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise TransientSmsError(f"twilio network error: {type(exc).__name__}") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientSmsError(f"twilio status {r.status_code}")
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code >= 400:
            code = str(body.get("code") or r.status_code)
            return SmsResult(accepted=False, provider=self.name, error_code=code,
                             error_message=str(body.get("message") or "Rejected")[:500],
                             permanent_failure=True)
        return SmsResult(accepted=True, provider=self.name, provider_message_id=body.get("sid"))


def twilio_signature(auth_token: str, url: str, params: dict[str, str]) -> str:
    payload = url + "".join(f"{k}{params[k]}" for k in sorted(params))
    return base64.b64encode(hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()).decode()


def verify_twilio(auth_token: str, url: str, params: dict[str, str], signature: str) -> bool:
    return bool(signature) and hmac.compare_digest(twilio_signature(auth_token, url, params), signature)

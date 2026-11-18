"""MSG91 adapter for India (DLT). Sends with the registered header and DLT template id.

The request format follows MSG91's v2 send API. Verify field names against your MSG91 account
before enabling live sending; this adapter has not been exercised against the live service.
"""
import httpx

from app.providers.sms.base import OutboundSms, SmsProvider, SmsResult, TransientSmsError

API = "https://api.msg91.com/api/v2/sendsms"
ROUTE = {"promotional": "1", "transactional": "4", "service": "4"}


class Msg91SmsProvider(SmsProvider):
    name = "msg91"

    def __init__(self, auth_key: str, timeout: float = 15.0):
        if not auth_key:
            raise ValueError("MSG91 auth key is required")
        self._key, self._timeout = auth_key, timeout

    def send(self, message: OutboundSms) -> SmsResult:
        if not message.dlt_template_id:
            return SmsResult(accepted=False, provider=self.name, error_code="DLT_TEMPLATE_MISSING",
                             error_message="Indian SMS requires a DLT template id", permanent_failure=True)
        payload = {
            "sender": message.sender_id,
            "route": ROUTE.get(message.category, "4"),
            "country": "91",
            "unicode": 1 if message.unicode else 0,
            "DLT_TE_ID": message.dlt_template_id,
            "sms": [{"message": message.body, "to": [message.to.lstrip("+").removeprefix("91")]}],
        }
        try:
            r = httpx.post(API, json=payload, headers={"authkey": self._key}, timeout=self._timeout)
        except httpx.HTTPError as exc:
            raise TransientSmsError(f"msg91 network error: {type(exc).__name__}") from exc
        if r.status_code == 429 or r.status_code >= 500:
            raise TransientSmsError(f"msg91 status {r.status_code}")
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code >= 400 or body.get("type") == "error":
            return SmsResult(accepted=False, provider=self.name, error_code=str(body.get("code") or r.status_code),
                             error_message=str(body.get("message") or "Rejected")[:500], permanent_failure=True)
        return SmsResult(accepted=True, provider=self.name, provider_message_id=str(body.get("message") or ""))

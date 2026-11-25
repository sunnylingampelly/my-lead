"""Brevo transactional email adapter (POST /v3/smtp/email)."""
import httpx

from app.providers.email.base import EmailProvider, OutboundEmail, SendResult, TransientProviderError

BREVO_URL = "https://api.brevo.com/v3/smtp/email"


class BrevoEmailProvider(EmailProvider):
    name = "brevo"

    def __init__(self, api_key: str, timeout: float = 15.0):
        if not api_key:
            raise ValueError("Brevo API key is required")
        self._api_key = api_key
        self._timeout = timeout

    def send(self, message: OutboundEmail) -> SendResult:
        payload: dict = {
            "sender": {"email": message.from_email, "name": message.from_name},
            "to": [{"email": message.to_email, **({"name": message.to_name} if message.to_name else {})}],
            "subject": message.subject,
            "htmlContent": message.html,
            "textContent": message.text,
        }
        if message.reply_to:
            payload["replyTo"] = {"email": message.reply_to}
        if message.headers:
            payload["headers"] = message.headers
        if message.tags:
            payload["tags"] = list(message.tags)
        if message.attachments:
            import base64

            payload["attachment"] = [{"name": name, "content": base64.b64encode(data).decode()}
                                     for name, _, data in message.attachments]
        try:
            resp = httpx.post(
                BREVO_URL,
                json=payload,
                headers={"api-key": self._api_key, "accept": "application/json"},
                timeout=self._timeout,
            )
        except httpx.HTTPError as exc:
            raise TransientProviderError(f"brevo network error: {type(exc).__name__}") from exc
        if resp.status_code in (429,) or resp.status_code >= 500:
            raise TransientProviderError(f"brevo status {resp.status_code}")
        if resp.status_code >= 400:
            body = _safe_json(resp)
            return SendResult(
                accepted=False,
                provider=self.name,
                error_code=str(body.get("code") or resp.status_code),
                error_message=str(body.get("message") or "Rejected by provider")[:500],
                permanent_failure=True,
            )
        return SendResult(accepted=True, provider=self.name, provider_message_id=_safe_json(resp).get("messageId"))


def _safe_json(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}

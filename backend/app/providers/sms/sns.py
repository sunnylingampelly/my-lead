"""Amazon SNS adapter for SMS in India (DLT) and the United States (10DLC, toll-free, short code).

Messages are sent with SNS Publish to a phone number. India uses the registered DLT header as the
sender ID plus the DLT entity and template IDs; the US uses a registered origination number.
Acceptance is not delivery: delivery comes from SNS delivery status logs (see sns_receipts).
"""
from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from botocore.exceptions import ConnectionError as BotoConnectionError

from app.providers.sms.base import OutboundSms, SmsProvider, SmsResult, TransientSmsError

TRANSIENT_CODES = {"Throttling", "ThrottlingException", "ThrottledException", "InternalError",
                   "InternalFailure", "ServiceUnavailable", "KMSThrottlingException", "RequestTimeout"}


@lru_cache(maxsize=4)
def sns_client(region: str, access_key: str | None, secret_key: str | None):
    """An SNS client. Without explicit keys, boto3 uses its default chain (env, profile, IAM role)."""
    return boto3.client("sns", region_name=region, aws_access_key_id=access_key or None,
                        aws_secret_access_key=secret_key or None,
                        config=Config(retries={"max_attempts": 2, "mode": "standard"},
                                      connect_timeout=5, read_timeout=15))


def credentials_available(region: str, access_key: str | None, secret_key: str | None) -> bool:
    session = boto3.Session(aws_access_key_id=access_key or None, aws_secret_access_key=secret_key or None,
                            region_name=region)
    return session.get_credentials() is not None


def _attr(value: str) -> dict:
    return {"DataType": "String", "StringValue": value}


def message_attributes(message: OutboundSms) -> dict:
    attrs = {"AWS.SNS.SMS.SMSType": _attr("Promotional" if message.category == "promotional" else "Transactional")}
    if message.country == "IN":
        attrs["AWS.SNS.SMS.SenderID"] = _attr(message.sender_id)
        if message.dlt_entity_id:
            attrs["AWS.MM.SMS.EntityId"] = _attr(message.dlt_entity_id)
        if message.dlt_template_id:
            attrs["AWS.MM.SMS.TemplateId"] = _attr(message.dlt_template_id)
    elif message.sender_id:
        attrs["AWS.MM.SMS.OriginationNumber"] = _attr(message.sender_id)
    return attrs


class SnsSmsProvider(SmsProvider):
    name = "sns"

    def __init__(self, client):
        self._client = client

    def send(self, message: OutboundSms) -> SmsResult:
        if message.country == "IN" and not (message.dlt_template_id and message.dlt_entity_id):
            return SmsResult(accepted=False, provider=self.name, error_code="DLT_MISSING",
                             error_message="Indian SMS needs the DLT entity ID and template ID",
                             permanent_failure=True)
        try:
            r = self._client.publish(PhoneNumber=message.to, Message=message.body,
                                     MessageAttributes=message_attributes(message))
        except ClientError as exc:
            err = exc.response.get("Error", {})
            code = str(err.get("Code") or "ClientError")
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode") or 0
            if code in TRANSIENT_CODES or status == 429 or status >= 500:
                raise TransientSmsError(f"sns {code}") from exc
            return SmsResult(accepted=False, provider=self.name, error_code=code[:64],
                             error_message=str(err.get("Message") or "Rejected")[:500], permanent_failure=True)
        except (BotoConnectionError, BotoCoreError) as exc:
            raise TransientSmsError(f"sns network error: {type(exc).__name__}") from exc
        return SmsResult(accepted=True, provider=self.name, provider_message_id=r.get("MessageId"))

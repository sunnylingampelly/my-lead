"""Amazon SES v2 adapter. boto3 is imported lazily so it is only required when SES is used."""
from app.providers.email.base import EmailProvider, OutboundEmail, SendResult, TransientProviderError

_TRANSIENT_CODES = {"Throttling", "ThrottlingException", "TooManyRequestsException", "ServiceUnavailable",
                    "InternalFailure", "LimitExceededException"}


def _raw_mime(message: OutboundEmail) -> bytes:
    """A MIME message for sends with attachments (SES Simple content carries none)."""
    from email.message import EmailMessage
    from email.utils import formataddr

    m = EmailMessage()
    m["Subject"] = message.subject
    m["From"] = formataddr((message.from_name, message.from_email))
    m["To"] = formataddr((message.to_name or "", message.to_email))
    if message.reply_to:
        m["Reply-To"] = message.reply_to
    for k, v in message.headers.items():
        m[k] = v
    m.set_content(message.text)
    m.add_alternative(message.html, subtype="html")
    for name, ctype, data in message.attachments:
        main, _, sub = ctype.partition("/")
        m.add_attachment(data, maintype=main, subtype=sub or "octet-stream", filename=name)
    return m.as_bytes()


class SesEmailProvider(EmailProvider):
    name = "ses"

    def __init__(self, region: str, access_key_id: str | None = None, secret_access_key: str | None = None,
                 configuration_set: str | None = None):
        import boto3

        self._client = boto3.client(
            "sesv2",
            region_name=region,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
        )
        self._configuration_set = configuration_set

    def send(self, message: OutboundEmail) -> SendResult:
        from botocore.exceptions import BotoCoreError, ClientError

        kwargs: dict = {
            "FromEmailAddress": f"{message.from_name} <{message.from_email}>",
            "Destination": {"ToAddresses": [message.to_email]},
            "Content": {
                "Simple": {
                    "Subject": {"Data": message.subject, "Charset": "UTF-8"},
                    "Body": {
                        "Html": {"Data": message.html, "Charset": "UTF-8"},
                        "Text": {"Data": message.text, "Charset": "UTF-8"},
                    },
                    "Headers": [{"Name": k, "Value": v} for k, v in message.headers.items()],
                }
            },
        }
        if message.attachments:
            kwargs["Content"] = {"Raw": {"Data": _raw_mime(message)}}
        if message.reply_to:
            kwargs["ReplyToAddresses"] = [message.reply_to]
        if self._configuration_set:
            kwargs["ConfigurationSetName"] = self._configuration_set
        if message.tags:
            kwargs["EmailTags"] = [{"Name": "tag", "Value": t[:256]} for t in message.tags[:1]]
        try:
            resp = self._client.send_email(**kwargs)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "ClientError")
            if code in _TRANSIENT_CODES:
                raise TransientProviderError(f"ses {code}") from exc
            return SendResult(accepted=False, provider=self.name, error_code=code,
                              error_message=str(exc.response.get("Error", {}).get("Message", ""))[:500],
                              permanent_failure=True)
        except BotoCoreError as exc:
            raise TransientProviderError(f"ses {type(exc).__name__}") from exc
        return SendResult(accepted=True, provider=self.name, provider_message_id=resp.get("MessageId"))

"""SMS provider contract."""
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class OutboundSms:
    to: str  # E.164
    sender_id: str  # DLT header, phone number or short code
    body: str
    category: str  # promotional|transactional|service
    unicode: bool = False
    dlt_template_id: str | None = None
    dlt_entity_id: str | None = None
    country: str = ""  # sender country (IN or US); decides India DLT vs US origination number
    idempotency_key: str | None = None


@dataclass(frozen=True)
class SmsResult:
    accepted: bool
    provider: str
    provider_message_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    permanent_failure: bool = False


class TransientSmsError(Exception):
    """Network errors, throttling (429) and 5xx responses: safe to retry with backoff."""


class SmsProvider(ABC):
    name = "base"

    @abstractmethod
    def send(self, message: OutboundSms) -> SmsResult:
        """Hand a message to the provider. Acceptance is not delivery; delivery comes by receipt."""

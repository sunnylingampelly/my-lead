"""Email provider contract shared by system (transactional) and campaign email."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass(frozen=True)
class OutboundEmail:
    to_email: str
    subject: str
    html: str
    text: str
    from_email: str
    from_name: str
    to_name: str | None = None
    reply_to: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    tags: tuple[str, ...] = ()
    # Stable key so a retried task can be recognised by providers or by our own records.
    idempotency_key: str | None = None
    # (filename, content type, bytes), e.g. an invoice PDF. Used by system email only.
    attachments: tuple[tuple[str, str, bytes], ...] = ()


@dataclass(frozen=True)
class SendResult:
    accepted: bool
    provider: str
    provider_message_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    # True when retrying cannot help (invalid address, rejected content, bad credentials).
    permanent_failure: bool = False


class TransientProviderError(Exception):
    """Network errors, throttling and 5xx responses. Safe to retry with backoff."""


class EmailProvider(ABC):
    name: str = "base"

    @abstractmethod
    def send(self, message: OutboundEmail) -> SendResult:
        """Hand a message to the provider. Acceptance is not delivery."""

"""Voice provider contract. A call plays a short script: spoken text and/or recorded audio,
optionally followed by a one-digit keypress prompt (opt-out)."""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ScriptStep:
    kind: str  # say|play
    text: str | None = None
    url: str | None = None
    language: str | None = None
    voice: str | None = None


@dataclass(frozen=True)
class CallScript:
    steps: tuple[ScriptStep, ...]
    gather_digit_url: str | None = None  # where the provider posts a keypress
    gather_prompt: ScriptStep | None = None


@dataclass(frozen=True)
class OutboundCall:
    to: str  # E.164
    caller_id: str
    script: CallScript
    status_callback: str | None = None
    script_url: str | None = None  # for providers that fetch the script (Exotel)
    machine_detection: bool = True
    idempotency_key: str | None = None
    meta: dict = field(default_factory=dict)


@dataclass(frozen=True)
class CallResult:
    accepted: bool
    provider: str
    provider_call_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None


class TransientVoiceError(Exception):
    """Network errors, throttling and 5xx responses: safe to retry later."""


class VoiceProvider(ABC):
    name = "base"

    @abstractmethod
    def place(self, call: OutboundCall) -> CallResult:
        """Start a call. Acceptance is not an answer; outcomes arrive by status callback."""

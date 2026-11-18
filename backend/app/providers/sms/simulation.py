"""Simulation provider: never contacts a carrier. Messages are written to a local outbox."""
import json
import uuid
from pathlib import Path

from app.core.config import settings
from app.providers.sms.base import OutboundSms, SmsProvider, SmsResult
from app.utils.time import utcnow


def outbox_path() -> Path:
    return Path(settings.SIMULATION_MAILBOX_PATH).parent / "sms_outbox"


def simulated_outcome(phone: str) -> str:
    """Deterministic test numbers: ending 0000 → undelivered (e.g. DND / handset off),
    ending 1111 → rejected by the provider at send time, anything else → delivered."""
    if phone.endswith("1111"):
        return "rejected"
    if phone.endswith("0000"):
        return "undelivered"
    return "delivered"


class SimulationSmsProvider(SmsProvider):
    name = "simulation"

    def send(self, message: OutboundSms) -> SmsResult:
        if simulated_outcome(message.to) == "rejected":
            return SmsResult(accepted=False, provider=self.name, error_code="REJECTED",
                             error_message="Rejected by the provider (simulated)", permanent_failure=True)
        box = outbox_path()
        box.mkdir(parents=True, exist_ok=True)
        mid = f"simsms-{uuid.uuid4()}"
        record = {"id": mid, "to": message.to, "from": message.sender_id, "body": message.body,
                  "category": message.category, "dlt_template_id": message.dlt_template_id,
                  "created_at": utcnow().isoformat()}
        (box / f"{utcnow().strftime('%Y%m%dT%H%M%S%f')}_{mid}.json").write_text(json.dumps(record), encoding="utf-8")
        return SmsResult(accepted=True, provider=self.name, provider_message_id=mid)

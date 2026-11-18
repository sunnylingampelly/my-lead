"""Simulation provider: never contacts the network. Messages are written to a local mailbox
directory so developers and tests can read them."""
import json
import uuid
from pathlib import Path

from app.core.config import settings
from app.providers.email.base import EmailProvider, OutboundEmail, SendResult
from app.utils.time import utcnow


class SimulationEmailProvider(EmailProvider):
    name = "simulation"

    def __init__(self, mailbox_path: str | None = None):
        self.mailbox = Path(mailbox_path or settings.SIMULATION_MAILBOX_PATH)

    def send(self, message: OutboundEmail) -> SendResult:
        self.mailbox.mkdir(parents=True, exist_ok=True)
        message_id = f"sim-{uuid.uuid4()}"
        record = {
            "id": message_id,
            "to": message.to_email,
            "to_name": message.to_name,
            "from": f"{message.from_name} <{message.from_email}>",
            "subject": message.subject,
            "text": message.text,
            "html": message.html,
            "tags": list(message.tags),
            "created_at": utcnow().isoformat(),
        }
        stamp = utcnow().strftime("%Y%m%dT%H%M%S%f")
        (self.mailbox / f"{stamp}_{message_id}.json").write_text(json.dumps(record), encoding="utf-8")
        return SendResult(accepted=True, provider=self.name, provider_message_id=message_id)

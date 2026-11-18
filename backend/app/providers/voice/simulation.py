"""Simulation provider: never dials anyone. Calls are written to a local call log."""
import json
import uuid
from pathlib import Path

from app.core.config import settings
from app.providers.voice.base import CallResult, OutboundCall, VoiceProvider
from app.utils.time import utcnow


def call_log_path() -> Path:
    return Path(settings.SIMULATION_MAILBOX_PATH).parent / "call_log"


def simulated_outcome(phone: str) -> str:
    """Deterministic test numbers by last four digits:
    0000 no answer, 2222 busy, 1111 rejected by the provider, 3333 voicemail,
    9999 answered and pressed 9 (opt-out); anything else is answered by a person."""
    return {"0000": "no_answer", "2222": "busy", "1111": "rejected", "3333": "voicemail",
            "9999": "opt_out"}.get(phone[-4:], "answered")


class SimulationVoiceProvider(VoiceProvider):
    name = "simulation"

    def place(self, call: OutboundCall) -> CallResult:
        if simulated_outcome(call.to) == "rejected":
            return CallResult(accepted=False, provider=self.name, error_code="REJECTED",
                              error_message="Rejected by the provider (simulated)")
        box = call_log_path()
        box.mkdir(parents=True, exist_ok=True)
        cid = f"simcall-{uuid.uuid4()}"
        record = {"id": cid, "to": call.to, "from": call.caller_id, "outcome": simulated_outcome(call.to),
                  "script": [{"kind": s.kind, "text": s.text, "url": s.url, "language": s.language}
                             for s in call.script.steps],
                  "keypress_prompt": call.script.gather_prompt.text if call.script.gather_prompt else None,
                  "created_at": utcnow().isoformat()}
        (box / f"{utcnow().strftime('%Y%m%dT%H%M%S%f')}_{cid}.json").write_text(json.dumps(record), encoding="utf-8")
        return CallResult(accepted=True, provider=self.name, provider_call_id=cid)

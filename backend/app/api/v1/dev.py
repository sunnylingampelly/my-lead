"""Development-only viewers for simulated emails and texts. Never mounted in production."""
import json
from pathlib import Path

from fastapi import APIRouter, Query

from app.core.config import settings
from app.core.errors import NotFound

router = APIRouter(prefix="/dev", tags=["Development"])


def _files() -> list[Path]:
    box = Path(settings.SIMULATION_MAILBOX_PATH)
    if not box.exists():
        return []
    return sorted(box.glob("*.json"), reverse=True)


@router.get("/mailbox")
def mailbox(to: str | None = Query(None, max_length=320), limit: int = Query(50, ge=1, le=200)):
    items = []
    for f in _files():
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if to and rec.get("to", "").lower() != to.strip().lower():
            continue
        items.append({k: rec.get(k) for k in ("id", "to", "from", "subject", "created_at", "text", "html")})
        if len(items) >= limit:
            break
    return {"items": items, "simulation": True}


@router.get("/mailbox/{message_id}")
def mailbox_message(message_id: str):
    for f in _files():
        if f.stem.endswith(message_id):
            return json.loads(f.read_text(encoding="utf-8"))
    raise NotFound("Message not found")


@router.get("/sms-outbox")
def sms_outbox(to: str | None = Query(None, max_length=20), limit: int = Query(50, ge=1, le=200)):
    from app.providers.sms.simulation import outbox_path

    box = outbox_path()
    items = []
    for f in sorted(box.glob("*.json"), reverse=True) if box.exists() else []:
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if to and rec.get("to") != to.strip():
            continue
        items.append(rec)
        if len(items) >= limit:
            break
    return {"items": items, "simulation": True}


@router.get("/call-log")
def call_log(limit: int = Query(50, ge=1, le=200)):
    from app.providers.voice.simulation import call_log_path

    box = call_log_path()
    items = []
    for f in sorted(box.glob("*.json"), reverse=True) if box.exists() else []:
        try:
            items.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
        if len(items) >= limit:
            break
    return {"items": items, "simulation": True}

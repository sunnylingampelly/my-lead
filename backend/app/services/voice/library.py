"""Caller IDs and the audio library (uploaded recordings and text-to-speech scripts)."""
import io

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import Conflict, NotFound, ValidationFailed
from app.core.logging import get_logger
from app.core.permissions import Perm
from app.integrations.storage import build_key, get_storage
from app.models.voice import VoiceAudio, VoiceCallerId, VoiceCampaign
from app.schemas.voice import AudioOut, AudioUpdate, CallerIn, TtsIn
from app.services import audit_service
from app.services.email import render, tokens
from app.services.tenancy import AppContext
from app.services.voice import rules
from app.utils.time import utcnow

log = get_logger(__name__)

ACTIVE = ("scheduled", "queued", "sending", "paused")
MAX_AUDIO_BYTES = 5 * 1024 * 1024
MAX_AUDIO_SECONDS = 120


def _audit(db: Session, ctx, action: str, target_type: str, target_id: str, summary: str | None = None) -> None:
    audit_service.record(db, action, actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
                         application_id=ctx.application_id, target_type=target_type, target_id=target_id,
                         summary=summary)


# ------------------------------------------------------------------ caller IDs


def caller_row(db: Session, ctx, caller_id: str) -> VoiceCallerId:
    c = db.scalar(select(VoiceCallerId).where(VoiceCallerId.id == caller_id,
                                              VoiceCallerId.application_id == ctx.application_id))
    if c is None:
        raise NotFound("Caller ID not found")
    return c


def list_callers(db: Session, ctx: AppContext) -> list[VoiceCallerId]:
    ctx.require(Perm.CAMPAIGNS_READ)
    return list(db.scalars(select(VoiceCallerId).where(VoiceCallerId.application_id == ctx.application_id)
                           .order_by(VoiceCallerId.is_default.desc(), VoiceCallerId.created_at)))


def create_caller(db: Session, ctx: AppContext, data: CallerIn) -> VoiceCallerId:
    ctx.require(Perm.SETTINGS_WRITE)
    err = rules.validate_caller(data.country, data.kind, data.number)
    if err:
        raise ValidationFailed(err, code="INVALID_CALLER_ID", details=[{"field": "number", "message": err}])
    if data.provider == "exotel" and data.country != "IN":
        raise ValidationFailed("Exotel is used for Indian numbers", code="PROVIDER_COUNTRY_MISMATCH")
    if db.scalar(select(VoiceCallerId.id).where(VoiceCallerId.application_id == ctx.application_id,
                                                VoiceCallerId.number == data.number)):
        raise Conflict(f"{data.number} is already added", code="CALLER_EXISTS")
    first = not db.scalar(select(func.count()).select_from(VoiceCallerId).where(
        VoiceCallerId.application_id == ctx.application_id))
    c = VoiceCallerId(organization_id=ctx.organization_id, application_id=ctx.application_id, number=data.number,
                      label=data.label, country=data.country, kind=data.kind, provider=data.provider,
                      status="pending", is_default=bool(first))
    db.add(c)
    db.flush()
    _audit(db, ctx, "voice.caller_created", "voice_caller", c.id, c.number)
    return c


def attest_caller(db: Session, ctx: AppContext, caller_id: str) -> VoiceCallerId:
    ctx.require(Perm.SETTINGS_WRITE)
    c = caller_row(db, ctx, caller_id)
    c.status, c.attested_by_id, c.attested_at = "active", ctx.user.id, utcnow()
    _audit(db, ctx, "voice.caller_attested", "voice_caller", c.id, c.number)
    return c


def make_default(db: Session, ctx: AppContext, caller_id: str) -> VoiceCallerId:
    ctx.require(Perm.SETTINGS_WRITE)
    c = caller_row(db, ctx, caller_id)
    db.execute(update(VoiceCallerId).where(VoiceCallerId.application_id == ctx.application_id).values(is_default=False))
    c.is_default = True
    return c


def delete_caller(db: Session, ctx: AppContext, caller_id: str) -> None:
    ctx.require(Perm.SETTINGS_WRITE)
    c = caller_row(db, ctx, caller_id)
    if db.scalar(select(VoiceCampaign.id).where(VoiceCampaign.caller_ref == c.id, VoiceCampaign.status.in_(ACTIVE))):
        raise Conflict("This caller ID is used by a scheduled or active campaign", code="CALLER_IN_USE")
    db.delete(c)
    _audit(db, ctx, "voice.caller_deleted", "voice_caller", caller_id, c.number)


# ------------------------------------------------------------------ audio


def audio_row(db: Session, ctx, audio_id: str) -> VoiceAudio:
    a = db.scalar(select(VoiceAudio).where(VoiceAudio.id == audio_id, VoiceAudio.application_id == ctx.application_id))
    if a is None:
        raise NotFound("Audio not found")
    return a


def audio_url(audio_id: str) -> str:
    """Signed, unguessable URL the provider (and the browser) can fetch the recording from."""
    return render.public_url(f"/public/voice/audio/{tokens.make('va', audio_id)}")


def audio_out(a: VoiceAudio) -> AudioOut:
    out = AudioOut.model_validate(a)
    if a.kind == "upload":
        out.url = audio_url(a.id)
    return out


def list_audio(db: Session, ctx: AppContext) -> list[AudioOut]:
    ctx.require(Perm.CAMPAIGNS_READ)
    rows = db.scalars(select(VoiceAudio).where(VoiceAudio.application_id == ctx.application_id)
                      .order_by(VoiceAudio.updated_at.desc()))
    return [audio_out(a) for a in rows]


def _sniff(data: bytes) -> tuple[str, str] | None:
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav", "wav"
    if data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0):
        return "audio/mpeg", "mp3"
    return None


def _duration(data: bytes, ext: str) -> float | None:
    try:
        if ext == "wav":
            from mutagen.wave import WAVE

            return float(WAVE(io.BytesIO(data)).info.length)
        from mutagen.mp3 import MP3

        return float(MP3(io.BytesIO(data)).info.length)
    except Exception:  # noqa: BLE001 - unreadable audio is rejected below
        return None


def upload_audio(db: Session, ctx: AppContext, name: str, data: bytes) -> AudioOut:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    if not data:
        raise ValidationFailed("The file is empty", code="EMPTY_FILE")
    if len(data) > MAX_AUDIO_BYTES:
        raise ValidationFailed("Recordings can be up to 5 MB", code="FILE_TOO_LARGE")
    kind = _sniff(data)
    if kind is None:
        raise ValidationFailed("Upload an MP3 or WAV recording", code="UNSUPPORTED_AUDIO")
    content_type, ext = kind
    seconds = _duration(data, ext)
    if seconds is None or seconds <= 0:
        raise ValidationFailed("This recording could not be read. Export it again as MP3 or WAV.", code="UNREADABLE_AUDIO")
    if seconds > MAX_AUDIO_SECONDS:
        raise ValidationFailed(f"Keep recordings under {MAX_AUDIO_SECONDS // 60} minutes; this one is "
                               f"{int(seconds)} seconds", code="AUDIO_TOO_LONG")
    key = build_key(ctx.organization_id, ctx.application_id, "voice-audio", ext)
    get_storage().put(key, data, content_type)
    a = VoiceAudio(organization_id=ctx.organization_id, application_id=ctx.application_id,
                   name=(name or "Recording").strip()[:120], kind="upload", storage_key=key,
                   content_type=content_type, size_bytes=len(data), duration_seconds=round(seconds, 2),
                   created_by_id=ctx.user.id)
    db.add(a)
    db.flush()
    _audit(db, ctx, "voice.audio_uploaded", "voice_audio", a.id, a.name)
    return audio_out(a)


def _check_tts(db: Session, ctx, text: str) -> None:
    from app.services.email.campaigns import custom_keys

    issues = render.check([text], custom_keys(db, ctx.application_id))
    bad = issues.unknown + [v for v in render.variables_in(text) if v in render.SYSTEM_VARIABLES]
    if bad or issues.malformed:
        raise ValidationFailed("Fix the personalisation fields: " + ", ".join(bad + issues.malformed),
                               code="INVALID_VARIABLES")


def create_tts(db: Session, ctx: AppContext, data: TtsIn) -> AudioOut:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    _check_tts(db, ctx, data.tts_text)
    a = VoiceAudio(organization_id=ctx.organization_id, application_id=ctx.application_id, name=data.name.strip(),
                   kind="tts", tts_text=data.tts_text.strip(), tts_language=data.tts_language,
                   tts_voice=data.tts_voice, duration_seconds=rules.spoken_seconds(data.tts_text),
                   created_by_id=ctx.user.id)
    db.add(a)
    db.flush()
    return audio_out(a)


def update_audio(db: Session, ctx: AppContext, audio_id: str, data: AudioUpdate) -> AudioOut:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = audio_row(db, ctx, audio_id)
    changes = {k: v for k, v in data.model_dump(exclude_unset=True).items() if v is not None}
    if a.kind != "tts" and set(changes) - {"name"}:
        raise ValidationFailed("Only the name of an uploaded recording can be changed", code="NOT_EDITABLE")
    if "tts_text" in changes:
        _check_tts(db, ctx, changes["tts_text"])
        a.duration_seconds = rules.spoken_seconds(changes["tts_text"])
    for k, v in changes.items():
        setattr(a, k, v.strip() if isinstance(v, str) and k in ("name", "tts_text") else v)
    db.flush()
    return audio_out(a)


def delete_audio(db: Session, ctx: AppContext, audio_id: str) -> None:
    ctx.require(Perm.CAMPAIGNS_WRITE)
    a = audio_row(db, ctx, audio_id)
    if db.scalar(select(VoiceCampaign.id).where(VoiceCampaign.audio_id == a.id, VoiceCampaign.status.in_(ACTIVE))):
        raise Conflict("This message is used by a scheduled or active campaign", code="AUDIO_IN_USE")
    key = a.storage_key
    db.delete(a)
    db.flush()
    if key:
        try:
            get_storage().delete(key)
        except Exception:  # noqa: BLE001 - an orphaned object is harmless; the row is gone
            log.warning("voice_audio_delete_failed", audio_id=audio_id)
    _audit(db, ctx, "voice.audio_deleted", "voice_audio", audio_id, a.name)


def read_audio(db: Session, token: str) -> tuple[bytes, str] | None:
    aid = tokens.read("va", token)
    a = db.get(VoiceAudio, aid) if aid else None
    if a is None or not a.storage_key:
        return None
    return get_storage().get(a.storage_key), a.content_type or "application/octet-stream"


def max_upload_info() -> dict:
    return {"max_bytes": MAX_AUDIO_BYTES, "max_seconds": MAX_AUDIO_SECONDS, "live": settings.COMMUNICATION_MODE == "live"}

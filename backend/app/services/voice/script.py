"""What a call says: business identification, the message (recording or text-to-speech) and the
opt-out prompt. Built from the snapshot frozen at launch, personalised per contact."""
from app.core.config import settings
from app.providers.voice.base import AgentRelay, CallScript, ScriptStep
from app.services.email import render, tokens
from app.services.voice import rules
from app.services.voice.library import audio_url


def default_language(country: str | None) -> str:
    return "en-US" if country == "US" else "en-IN"


def snapshot_message(audio, caller, campaign) -> dict:
    """Freeze everything a call needs, so later edits to the audio or caller cannot change a sent campaign."""
    return {
        "caller_number": caller.number, "country": caller.country, "kind": caller.kind, "provider": caller.provider,
        "audio_id": audio.id, "audio_kind": audio.kind, "audio_name": audio.name,
        "tts_text": audio.tts_text, "language": audio.tts_language or default_language(caller.country),
        "voice": audio.tts_voice or "female", "audio_seconds": float(audio.duration_seconds or 0),
        "intro_text": (campaign.intro_text or "").strip() or None, "opt_out_keypress": campaign.opt_out_keypress,
    }


def snapshot_agent(agent, caller, campaign, business_name: str) -> dict:
    """AI-agent campaigns: the agent (version and behaviour) and caller frozen at launch."""
    from app.services.voice.agents import snapshot as agent_snapshot

    return {
        "message_type": "ai_agent", "caller_number": caller.number, "country": caller.country, "kind": caller.kind,
        "provider": caller.provider, "agent": agent_snapshot(agent), "agent_id": agent.id,
        "agent_version": agent.version, "agent_name": agent.name, "language": agent.language, "voice": agent.voice,
        "business_name": business_name, "intro_text": None,
        # Pressing 9 during the conversation always opts out.
        "opt_out_keypress": True,
    }


def build(snap: dict, contact, call_id: str | None, sample: bool = False) -> CallScript:
    if snap.get("message_type") == "ai_agent":
        return build_agent(snap, contact, call_id, sample)
    values = render.contact_values(contact, sample=sample)
    lang, voice = snap.get("language"), snap.get("voice")
    steps = []
    if snap.get("intro_text"):
        steps.append(ScriptStep("say", text=render.substitute(snap["intro_text"], values, escape=False),
                                language=lang, voice=voice))
    if snap.get("audio_kind") == "tts":
        steps.append(ScriptStep("say", text=render.substitute(snap.get("tts_text") or "", values, escape=False),
                                language=lang, voice=voice))
    elif snap.get("audio_id"):
        steps.append(ScriptStep("play", url=audio_url(snap["audio_id"])))
    gather_url = prompt = None
    if snap.get("opt_out_keypress"):
        prompt = ScriptStep("say", text=rules.opt_out_prompt(lang), language=lang, voice=voice)
        if call_id:
            gather_url = render.public_url(f"/public/voice/keypress/{tokens.make('vk', call_id)}")
    return CallScript(steps=tuple(steps), gather_digit_url=gather_url, gather_prompt=prompt)


def build_agent(snap: dict, contact, call_id: str | None, sample: bool = False) -> CallScript:
    from app.services.voice import ai, relay

    agent = snap.get("agent") or {}
    values = ai.values_for("Asha" if sample and contact is None else None, snap.get("business_name") or "us", contact)
    greeting = ai.greeting_for(agent, values)
    lang, voice = agent.get("language") or snap.get("language"), agent.get("voice") or snap.get("voice")
    rel = AgentRelay(url=relay.ws_url(call_id), greeting=greeting, language=lang, voice=voice,
                     action_url=relay.action_url(call_id)) if call_id else None
    return CallScript(steps=(ScriptStep("say", text=greeting, language=lang, voice=voice),), relay=rel)


def as_text(script: CallScript) -> list[dict]:
    out = [{"kind": s.kind, "text": s.text, "url": s.url} for s in script.steps]
    if script.gather_prompt:
        out.append({"kind": "keypress", "text": script.gather_prompt.text, "url": None})
    return out


def estimated_seconds(snap: dict) -> float:
    if snap.get("message_type") == "ai_agent":
        return float(settings.AI_CALL_EXPECTED_MINUTES * 60)
    total = rules.spoken_seconds(snap.get("intro_text") or "")
    total += snap.get("audio_seconds") or 0
    if snap.get("opt_out_keypress"):
        total += rules.spoken_seconds(rules.opt_out_prompt(snap.get("language"))) + 5  # wait for a keypress
    return round(total + 2, 1)  # connection and pauses


def status_callback(provider: str, call_id: str, attempt: int) -> str | None:
    if provider == "telnyx":
        # The signed token binds the callback to this call; the attempt number ignores late events
        # from an earlier attempt.
        return render.public_url(f"/webhooks/voice/telnyx/status/{tokens.make('vt', call_id)}/{attempt}")
    if provider == "twilio":
        return render.public_url("/webhooks/voice/twilio/status")
    if provider == "exotel":
        return render.public_url(f"/webhooks/voice/exotel/status?token={settings.EXOTEL_WEBHOOK_TOKEN or ''}")
    return None

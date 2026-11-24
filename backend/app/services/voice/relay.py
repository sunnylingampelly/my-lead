"""Live AI-agent calls over Twilio ConversationRelay.

Twilio answers the call, speaks the agent's greeting (welcomeGreeting), transcribes the person and
connects to our WebSocket. Messages we receive: setup, prompt (voicePrompt, last), interrupt
(utteranceUntilInterrupt), dtmf (digit), info, error. Messages we send: text (token, last) and end
(handoffData). After "end", Twilio requests the <Connect action> URL, which dials the transfer number
for a hand-off or hangs up.

The session is transport-agnostic (receive/send callables) so it can be tested without a socket.
Database work runs in a thread so the event loop is never blocked.
"""
import asyncio
import json
from collections.abc import Awaitable, Callable

from app.core.database import SessionLocal
from app.core.logging import get_logger
from app.models import Contact
from app.models.voice import VoiceCall, VoiceCampaign
from app.services.email import render, tokens
from app.services.voice import ai, events, rules
from app.utils.time import utcnow

log = get_logger(__name__)
FINAL = ("completed", "voicemail", "no_answer", "busy", "failed", "skipped")
OPT_OUT_LINE = "Understood. You won't receive further calls from us. Goodbye."
TIME_UP_LINE = "I'm afraid we're out of time for today. Someone from our team will follow up. Thank you, goodbye."
MAX_TURNS = 60

Receive = Callable[[], Awaitable[dict | None]]
Send = Callable[[dict], Awaitable[None]]


def ws_token(call_id: str) -> str:
    return tokens.make("vw", call_id)


def verify(call_id: str, token: str | None) -> bool:
    return bool(token) and tokens.read("vw", token or "") == call_id


def ws_url(call_id: str) -> str:
    base = render.public_url(f"/public/voice/agent/{call_id}/ws")
    base = "wss://" + base.split("://", 1)[1] if base.startswith("https://") else "ws://" + base.split("://", 1)[1]
    return f"{base}?token={ws_token(call_id)}"


def action_url(call_id: str) -> str:
    return render.public_url(f"/public/voice/agent/{call_id}/action?token={ws_token(call_id)}")


def _load(call_id: str) -> dict | None:
    """Everything the session needs, read once at setup."""
    from app.services.voice.ai_results import _business_name

    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        if call is None or call.status in FINAL:
            return None
        campaign = db.get(VoiceCampaign, call.campaign_id)
        agent = (campaign.snapshot or {}).get("agent") if campaign else None
        if not agent:
            return None
        contact = db.get(Contact, call.contact_id) if call.contact_id else None
        values = ai.values_for(None, _business_name(db, campaign), contact)
        transcript = list(call.transcript or [])
        if not transcript:
            transcript = [{"role": "assistant", "text": ai.greeting_for(agent, values), "at": utcnow().isoformat()}]
            call.transcript = transcript
            db.commit()
        return {"agent": agent, "values": values, "transcript": transcript}


def _save(call_id: str, transcript: list[dict]) -> None:
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        if call is not None:
            call.transcript = list(transcript)
            db.commit()


def _opt_out(call_id: str) -> None:
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        if call is not None:
            events.apply(db, call, "keypress", provider=call.provider,
                         provider_event_id=f"{call.provider_call_id or call.id}:relay:dtmf:{rules.OPT_OUT_DIGIT}",
                         digits=rules.OPT_OUT_DIGIT)
            events.opt_out(db, call)
            db.commit()


class RelaySession:
    def __init__(self, call_id: str, receive: Receive, send: Send, streamer=None):
        self.call_id, self._receive, self._send = call_id, receive, send
        self.stream = streamer or ai.stream_reply
        self.agent: dict | None = None
        self.values: dict = {}
        self.transcript: list[dict] = []
        self.started = None
        self.ended = False
        self.turns = 0
        self._watchdog: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def send(self, msg: dict) -> None:
        if not self.ended or msg.get("type") == "end":
            await self._send(msg)

    async def say(self, text: str) -> None:
        await self.send({"type": "text", "token": text, "last": True})

    async def end(self, reason: str, extra: dict | None = None) -> None:
        if self.ended:
            return
        await self._send({"type": "end", "handoffData": json.dumps({"reason": reason, **(extra or {})})})
        self.ended = True

    def _turn(self, role: str, text: str) -> None:
        self.transcript.append({"role": role, "text": text, "at": utcnow().isoformat()})

    async def persist(self) -> None:
        await asyncio.to_thread(_save, self.call_id, self.transcript)

    # -------------------------------------------------------------- lifecycle

    async def run(self) -> None:
        try:
            while not self.ended:
                msg = await self._receive()
                if msg is None:
                    break
                await self.handle(msg)
        finally:
            if self._watchdog:
                self._watchdog.cancel()
            if self.transcript:
                try:
                    await self.persist()
                except Exception:  # noqa: BLE001
                    log.exception("relay_persist_failed", call_id=self.call_id)

    async def handle(self, msg: dict) -> None:
        t = msg.get("type")
        try:
            if t == "setup":
                await self.on_setup(msg)
            elif self.agent is None:
                return  # nothing before setup
            elif t == "prompt":
                if msg.get("last", True):
                    await self.on_prompt(str(msg.get("voicePrompt") or ""))
            elif t == "interrupt":
                self.on_interrupt(str(msg.get("utteranceUntilInterrupt") or ""))
            elif t == "dtmf":
                await self.on_dtmf(str(msg.get("digit") or ""))
            elif t == "error":
                log.warning("relay_error", call_id=self.call_id, description=str(msg.get("description"))[:300])
        except Exception:  # noqa: BLE001 - never crash the socket; end the call politely
            log.exception("relay_handler_failed", call_id=self.call_id, type=t)
            await self.say(ai.ERROR_LINE)
            await self.end("error")

    async def on_setup(self, msg: dict) -> None:
        data = await asyncio.to_thread(_load, self.call_id)
        if data is None:
            await self.end("unknown_call")
            return
        self.agent, self.values, self.transcript = data["agent"], data["values"], data["transcript"]
        self.started = utcnow()
        minutes = int(self.agent.get("max_call_minutes") or 5)
        self._watchdog = asyncio.create_task(self._time_limit(minutes * 60))

    async def _time_limit(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
        async with self._lock:
            if not self.ended:
                self._turn("assistant", TIME_UP_LINE)
                await self.say(TIME_UP_LINE)
                await self.persist()
                await self.end("time_limit")

    async def on_prompt(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        async with self._lock:
            if self.ended:
                return
            self._turn("user", text)
            self.turns += 1
            if self.turns > MAX_TURNS:
                self._turn("assistant", TIME_UP_LINE)
                await self.say(TIME_UP_LINE)
                await self.persist()
                await self.end("time_limit")
                return
            messages = [{"role": x["role"], "content": x["text"]} for x in self.transcript]
            f = ai.MarkerFilter()
            spoken: list[str] = []
            outcome = "done"
            async for kind, value in self.stream(self.agent, messages, self.values):
                if kind == "text":
                    piece = f.feed(value)
                    if piece:
                        spoken.append(piece)
                        await self.send({"type": "text", "token": piece, "last": False})
                else:
                    outcome = kind
            rest = f.flush()
            if outcome in ("refusal", "error"):
                line = ai.REFUSAL_LINE if outcome == "refusal" else ai.ERROR_LINE
                rest += (" " if (spoken or rest) else "") + line
            if rest:
                spoken.append(rest)
            await self.send({"type": "text", "token": rest, "last": True})
            reply = "".join(spoken).strip()
            self._turn("assistant", reply)
            await self.persist()
            if outcome in ("refusal", "error"):
                await self.end(outcome)
            elif f.transfer and self.agent.get("transfer_number"):
                await self.end("transfer", {"transfer_to": self.agent["transfer_number"]})
            elif f.end or f.transfer:
                await self.end("completed")

    def on_interrupt(self, utterance: str) -> None:
        """The person spoke over the agent: keep only what was actually heard."""
        for turn in reversed(self.transcript):
            if turn["role"] == "assistant":
                heard = utterance.strip()
                turn["text"] = (heard + " …") if heard else "…"
                turn["interrupted"] = True
                break

    async def on_dtmf(self, digit: str) -> None:
        if digit != rules.OPT_OUT_DIGIT:
            return
        async with self._lock:
            self._turn("user", f"(pressed {digit})")
            self._turn("assistant", OPT_OUT_LINE)
            await asyncio.to_thread(_opt_out, self.call_id)
            await self.say(OPT_OUT_LINE)
            await self.persist()
            await self.end("opt_out")


def action_twiml(call_id: str, handoff: str | None) -> str:
    """TwiML for <Connect action>: dial the transfer number on a hand-off, otherwise hang up."""
    from xml.sax.saxutils import escape

    data = {}
    try:
        data = json.loads(handoff) if handoff else {}
    except ValueError:
        data = {}
    to = data.get("transfer_to") if isinstance(data, dict) else None
    with SessionLocal() as db:
        call = db.get(VoiceCall, call_id)
        campaign = db.get(VoiceCampaign, call.campaign_id) if call else None
        agent = (campaign.snapshot or {}).get("agent") if campaign else None
    # Only ever dial the number configured on the agent, never one taken from the request.
    if to and agent and to == agent.get("transfer_number"):
        return ('<?xml version="1.0" encoding="UTF-8"?><Response>'
                f"<Dial>{escape(to)}</Dial></Response>")
    return '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'

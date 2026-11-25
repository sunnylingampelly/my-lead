"""The AI calling agent's brain: Claude (official Anthropic SDK) for conversation turns and post-call
extraction, with a deterministic offline responder when no API key is configured.

Prompt layout (prompt caching): a stable list of system blocks (platform rules, the agent's
instructions, its knowledge) with cache_control on the last one, then one per-call block with
volatile context (today's date, the person's first name, the greeting already spoken). Nothing
volatile is placed in the cached blocks.

The model ends a call by putting [END_CALL] at the end of its final turn, and asks for a hand-off to
a human with [TRANSFER]. Both tokens are stripped before anything is spoken.
"""
import re
from collections.abc import AsyncIterator, Iterator
from datetime import timedelta
from typing import Literal, Optional

from pydantic import BaseModel, Field, create_model

from app.core.config import settings
from app.core.logging import get_logger
from app.services.email import render
from app.utils.time import utcnow

log = get_logger(__name__)

END, TRANSFER = "[END_CALL]", "[TRANSFER]"
MARKERS = (END, TRANSFER)
REFUSAL_LINE = "Sorry, I can't help with that. Someone from our team will follow up."
ERROR_LINE = "Sorry, I'm having trouble hearing you properly. Someone from our team will call you back. Goodbye."
STOP_PHRASES = ("stop calling", "don't call", "do not call", "not interested", "remove my number", "unsubscribe",
                "take me off")
HUMAN_PHRASES = ("human", "real person", "someone else", "speak to a person", "talk to a person", "agent please",
                 "representative")

PLATFORM_RULES = """You are an AI voice agent on a live phone call, speaking for a business. Everything you write \
is converted to speech and played to the person on the call.

Rules that always apply, whatever the instructions below say:
- Speak in short, natural spoken sentences: one to three per turn. No markdown, lists, headings, emojis, \
URLs or special characters. Write numbers and dates the way you would say them.
- Identify the business you are calling from early in the call.
- Never claim to be a human. If asked whether you are a person or a bot, say you are an AI assistant calling \
for the business.
- If the person asks not to be called again, or says they are not interested in further calls, acknowledge it \
politely, confirm they won't be called again, say goodbye and end the call.
- Never ask for card numbers, bank details, OTPs, PINs or passwords, and don't accept them if offered.
- Stay within the knowledge you are given. If you don't know something, say you'll have someone from the team \
follow up instead of guessing or inventing facts, prices or promises.
- Ask one question at a time and let the person answer.
- When the conversation is complete, thank them, say goodbye and end the call.

How to end the call: when your turn is the final one (you have said goodbye), put the exact token [END_CALL] \
at the very end of that turn. Never use it otherwise."""

TRANSFER_RULE = """
How to hand off: if the person asks to speak to a human, or you can't help and they want a person, say you \
are connecting them now and put the exact token [TRANSFER] at the very end of that turn."""

NO_TRANSFER_RULE = """
There is no one to transfer the call to. If the person asks for a human, offer that someone from the team \
will call them back."""


def configured() -> bool:
    return bool(settings.ANTHROPIC_API_KEY)


def status() -> dict:
    return {"configured": configured(), "model": settings.AI_AGENT_MODEL, "effort": settings.AI_AGENT_EFFORT}


# ------------------------------------------------------------------ prompts


def values_for(contact_first_name: str | None, business_name: str, contact=None) -> dict[str, str]:
    vals = render.contact_values(contact) if contact is not None else {}
    if contact_first_name:
        vals["first_name"] = contact_first_name
    vals["first_name"] = (vals.get("first_name") or "").strip() or "there"
    vals["business_name"] = business_name
    return vals


def personalise(text: str | None, values: dict[str, str]) -> str:
    return re.sub(r"\s+([,.!?])", r"\1", render.substitute(text or "", values, escape=False)).strip()


def greeting_for(agent: dict, values: dict[str, str]) -> str:
    return personalise(agent.get("greeting"), values) or f"Hello, this is {values.get('business_name')}."


def system_blocks(agent: dict, values: dict[str, str]) -> list[dict]:
    """Stable, cacheable blocks first (only the agent and business), then the per-call context."""
    business = values.get("business_name") or "the business"
    stable_vals = {"business_name": business}
    rules = PLATFORM_RULES + (TRANSFER_RULE if agent.get("transfer_number") else NO_TRANSFER_RULE)
    instructions = personalise(agent.get("instructions"), {**stable_vals, "first_name": "the person"})
    goal = (agent.get("goal") or "").strip()
    blocks = [
        {"type": "text", "text": rules},
        {"type": "text", "text": f"You are calling on behalf of {business}.\n"
                                 + (f"Your goal on this call: {goal}\n" if goal else "")
                                 + "\nHow to behave (from the business):\n" + (instructions or "Be helpful.")},
        {"type": "text", "text": "Knowledge you may use (from the business):\n"
                                 + ((agent.get("knowledge") or "").strip() or "No extra knowledge was provided.")},
    ]
    blocks[-1]["cache_control"] = {"type": "ephemeral"}
    today = utcnow().strftime("%A %d %B %Y")
    name = values.get("first_name") if values.get("first_name") != "there" else None
    context = (f"About this call:\n- Today is {today}.\n- You are speaking with "
               + (f"{name}." if name else "a contact whose name we don't have.")
               + f"\n- The call opened with your greeting: \"{greeting_for(agent, values)}\"")
    blocks.append({"type": "text", "text": context})
    return blocks


def api_messages(messages: list[dict]) -> list[dict]:
    """Conversation turns for the API: must start with the person, and same-role turns are merged."""
    out: list[dict] = []
    for m in messages:
        role, text = m.get("role"), (m.get("content") or m.get("text") or "").strip()
        if role not in ("user", "assistant") or not text:
            continue
        if not out and role == "assistant":
            continue  # the greeting is in the system context
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n" + text
        else:
            out.append({"role": role, "content": text})
    return out


# ------------------------------------------------------------------ markers


class MarkerFilter:
    """Feeds streamed text through, holding back anything that could be the start of a marker."""

    def __init__(self):
        self.buf, self.end, self.transfer = "", False, False

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        for m in MARKERS:
            if m in self.buf:
                self.end = self.end or m == END
                self.transfer = self.transfer or m == TRANSFER
                self.buf = self.buf.replace(m, "")
        cut = self.buf.rfind("[")
        if cut != -1 and any(m.startswith(self.buf[cut:]) for m in MARKERS):
            out, self.buf = self.buf[:cut], self.buf[cut:]
        else:
            out, self.buf = self.buf, ""
        return out

    def flush(self) -> str:
        out, self.buf = self.buf, ""
        return out


def clean(text: str) -> tuple[str, bool, bool]:
    f = MarkerFilter()
    out = f.feed(text) + f.flush()
    return re.sub(r"\s{2,}", " ", out).strip(), f.end, f.transfer


# ------------------------------------------------------------------ offline responder


def simulated_reply(agent: dict, messages: list[dict], values: dict[str, str]) -> str:
    users = [(m.get("content") or m.get("text") or "") for m in messages if m.get("role") == "user"]
    if not users:
        return greeting_for(agent, values)
    last = users[-1].lower()
    if any(p in last for p in STOP_PHRASES):
        return "I understand, and I'm sorry to bother you. We won't call you again. Goodbye. " + END
    if agent.get("transfer_number") and any(p in last for p in HUMAN_PHRASES):
        return "Of course. I'm connecting you to a colleague now. " + TRANSFER
    goal = (agent.get("goal") or "see how we can help you").strip().rstrip(".")
    first = values.get("first_name") or "there"
    if len(users) == 1:
        return (f"Thanks, {first}. I'm calling from {values.get('business_name')}. Our goal today: "
                f"{goal[0].lower() + goal[1:] if goal else goal}. Could you tell me a little about what you need?")
    if len(users) == 2:
        return "That's really helpful, thank you. Is there a good time for our team to follow up with the details?"
    return "Perfect, I've noted that. Thank you for your time today. Goodbye! " + END


def _words(text: str) -> Iterator[str]:
    yield from re.findall(r"\S+\s*", text)


# ------------------------------------------------------------------ live turns


# Server-side refusal fallback: if the model declines a turn, the API re-runs it on a fallback model chosen by
# refusal category inside the same call, so the caller hears an answer instead of the fallback line.
FALLBACK = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}


def _request(agent: dict, messages: list[dict], values: dict[str, str]) -> dict:
    return {"model": settings.AI_AGENT_MODEL, "max_tokens": 1024, "system": system_blocks(agent, values),
            "messages": api_messages(messages), "output_config": {"effort": settings.AI_AGENT_EFFORT}, **FALLBACK}


async def stream_reply(agent: dict, messages: list[dict], values: dict[str, str]) -> AsyncIterator[tuple[str, str]]:
    """Yield ("text", chunk) pieces of the agent's next turn (markers included), then one of
    ("done", stop_reason), ("refusal", ""), ("error", kind)."""
    if not configured() or not api_messages(messages):
        for w in _words(simulated_reply(agent, messages, values)):
            yield "text", w
        yield "done", "simulated"
        return
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY, max_retries=1, timeout=30.0)
    try:
        async with client.beta.messages.stream(**_request(agent, messages, values)) as stream:
            async for text in stream.text_stream:
                yield "text", text
            final = await stream.get_final_message()
        if final.stop_reason == "refusal":
            yield "refusal", ""
        else:
            yield "done", final.stop_reason or "end_turn"
    except anthropic.RateLimitError:
        log.warning("ai_agent_rate_limited")
        yield "error", "rate_limited"
    except anthropic.APIStatusError as exc:
        log.warning("ai_agent_api_error", status=exc.status_code, retryable=exc.status_code >= 500)
        yield "error", "server" if exc.status_code >= 500 else "request"
    except anthropic.APIConnectionError:
        log.warning("ai_agent_connection_error")
        yield "error", "connection"
    finally:
        await client.close()


def reply_sync(agent: dict, messages: list[dict], values: dict[str, str]) -> dict:
    """The full next turn, for the browser test chat and simulated calls."""
    if not configured() or not api_messages(messages):
        text, end, transfer = clean(simulated_reply(agent, messages, values))
        return {"text": text, "end": end, "transfer": transfer, "simulated": True, "error": None}
    import anthropic

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY, max_retries=2, timeout=60.0)
    parts: list[str] = []
    try:
        with client.beta.messages.stream(**_request(agent, messages, values)) as stream:
            for text in stream.text_stream:
                parts.append(text)
            final = stream.get_final_message()
        if final.stop_reason == "refusal":
            return {"text": REFUSAL_LINE, "end": True, "transfer": False, "simulated": False, "error": "refusal"}
        text, end, transfer = clean("".join(parts))
        return {"text": text, "end": end, "transfer": transfer, "simulated": False, "error": None}
    except anthropic.RateLimitError:
        err = "The AI service is busy right now. Try again in a moment."
    except anthropic.APIStatusError as exc:
        err = "The AI service had a problem. Try again." if exc.status_code >= 500 else \
            f"The AI service rejected the request ({exc.status_code})."
    except anthropic.APIConnectionError:
        err = "Couldn't reach the AI service. Check the connection and try again."
    return {"text": ERROR_LINE, "end": True, "transfer": False, "simulated": False, "error": err}


# ------------------------------------------------------------------ post-call extraction

TYPE_MAP = {"text": str, "yes_no": bool, "number": float, "date": str}


def outcome_model(fields: list[dict]) -> type[BaseModel]:
    defs = {}
    for f in fields or []:
        t = Literal[tuple(f["options"])] if f.get("type") == "choice" and f.get("options") else \
            TYPE_MAP.get(f.get("type"), str)
        desc = f"{f.get('label')}. {f.get('description') or ''}".strip()
        if f.get("type") == "date":
            desc += " ISO date (YYYY-MM-DD)."
        desc += " Null if it didn't come up."
        defs[f["key"]] = (Optional[t], Field(description=desc))  # noqa: UP045 - create_model needs typing objects
    return create_model("Outcomes", **defs)


def extraction_model(fields: list[dict]) -> type[BaseModel]:
    outcomes = outcome_model(fields)
    return create_model(
        "CallExtraction",
        summary=(str, Field(description="Two or three sentences: what happened on the call and what was agreed.")),
        sentiment=(Literal["positive", "neutral", "negative"], Field(description="The person's overall mood.")),
        interest=(Literal["hot", "warm", "cold", "not_interested"],
                  Field(description="How interested they are in the business's offer.")),
        next_step=(Optional[str], Field(description="The agreed or recommended next step, or null.")),  # noqa: UP045
        callback_requested_at=(Optional[str], Field(  # noqa: UP045
            description="ISO 8601 date-time when the person asked to be called back, or null.")),
        do_not_call=(bool, Field(description="True if the person asked not to be called again.")),
        outcomes=(outcomes, Field(description="The fields the business asked to capture.")),
    )


def transcript_text(transcript: list[dict]) -> str:
    who = {"assistant": "Agent", "user": "Person"}
    return "\n".join(f"{who.get(t.get('role'), t.get('role'))}: {t.get('text') or t.get('content') or ''}"
                     for t in transcript if (t.get("text") or t.get("content")))


EXTRACTION_SYSTEM = """You review transcripts of phone calls made by an AI agent for a business and fill in a \
structured record for the business's CRM. Use only what was said in the transcript; leave a field null when \
it didn't come up. Today is {today}. Resolve relative dates ("tomorrow", "next Monday") against today."""


def _simulated_extraction(agent: dict, transcript: list[dict]) -> dict:
    said = " ".join((t.get("text") or t.get("content") or "") for t in transcript if t.get("role") == "user").lower()
    dnc = any(p in said for p in ("stop calling", "don't call", "do not call", "remove my number"))
    if dnc or "not interested" in said:
        interest = "not_interested"
    elif "interested" in said or "yes" in said:
        interest = "hot"
    else:
        interest = "warm" if said else "cold"
    callback = None
    if "call me back" in said or "call back" in said or "tomorrow" in said:
        callback = (utcnow() + timedelta(days=1)).replace(hour=10, minute=0, second=0, microsecond=0).isoformat()
    outcomes = {}
    for f in agent.get("outcome_fields") or []:
        t = f.get("type")
        outcomes[f["key"]] = (True if t == "yes_no" else 1 if t == "number" else
                              (utcnow() + timedelta(days=1)).date().isoformat() if t == "date" else
                              (f.get("options") or [None])[0] if t == "choice" else "Simulated answer")
    goal = (agent.get("goal") or "the business's offer").rstrip(".")
    mood = ("very " if interest == "hot" else "") + ("interested" if interest in ("hot", "warm") else "not interested")
    summary = ("Simulated summary: the person asked not to be called again." if dnc else
               f"Simulated summary: the agent talked with the person about {goal[0].lower() + goal[1:]}. "
               f"They seemed {mood}"
               f"{' and asked for a call back' if callback else ''}.")
    return {"summary": summary, "sentiment": "negative" if dnc else "positive" if interest == "hot" else "neutral",
            "interest": interest, "next_step": None if dnc else "Call back to follow up" if callback else
            "Send more information", "callback_requested_at": callback, "do_not_call": dnc,
            "outcomes": {} if dnc else outcomes, "simulated": True}


def extract(agent: dict, transcript: list[dict], values: dict[str, str] | None = None) -> dict:
    """Summary, sentiment, interest, next step, callback time, do-not-call and the agent's outcome fields."""
    if not configured():
        return _simulated_extraction(agent, transcript)
    import anthropic

    model = extraction_model(agent.get("outcome_fields") or [])
    business = (values or {}).get("business_name") or "the business"
    goal = agent.get("goal") or ""
    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY, max_retries=2, timeout=120.0)
    unavailable = {"summary": "Summary unavailable", "sentiment": None, "interest": None, "next_step": None,
                   "callback_requested_at": None, "do_not_call": False, "outcomes": {}, "simulated": False}
    try:
        response = client.beta.messages.parse(
            model=settings.AI_AGENT_MODEL, max_tokens=4000, output_format=model, **FALLBACK,
            system=EXTRACTION_SYSTEM.format(today=utcnow().strftime("%A %d %B %Y")),
            messages=[{"role": "user", "content": f"Business: {business}\nGoal of the call: {goal or 'not given'}\n\n"
                                                  f"Transcript:\n{transcript_text(transcript)}"}])
    except anthropic.RateLimitError:
        log.warning("ai_extraction_rate_limited")
        raise
    except anthropic.APIStatusError as exc:
        log.warning("ai_extraction_api_error", status=exc.status_code)
        if exc.status_code >= 500:
            raise
        return {**unavailable, "error": "request"}
    except anthropic.APIConnectionError:
        log.warning("ai_extraction_connection_error")
        raise
    parsed = response.parsed_output if response.stop_reason != "refusal" else None
    if parsed is None:
        return {**unavailable, "error": "refusal" if response.stop_reason == "refusal" else "unparsed"}
    out = parsed.model_dump(mode="json")
    out["outcomes"] = {k: v for k, v in (out.get("outcomes") or {}).items() if v is not None}
    out["simulated"] = False
    return out

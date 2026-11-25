"""The model behind the AI Team: OpenAI's Responses API through the official `openai` SDK, with function tools.

Docs: https://developers.openai.com/api/docs/guides/function-calling (tools are
{"type": "function", "name", "description", "parameters"}; calls come back as `function_call` output items with
`call_id`, `name` and JSON `arguments`; results go back as {"type": "function_call_output", "call_id", "output"}),
https://developers.openai.com/api/docs/guides/streaming-responses (`response.output_text.delta` events carry
`delta`; `response.completed` carries the final `response` with `usage.input_tokens/output_tokens`).
The current flagship model needs the Responses API for tool calling, so Chat Completions is not used.

Requests are stateless (`store=False`, with encrypted reasoning items passed back within a turn), so tenant
data is not kept by the API between requests.

Without OPENAI_API_KEY, `Simulator` stands in: a deterministic planner that maps a few prompt patterns to tool
calls and writes its answer from the tool results. Every simulated answer is flagged `simulated=True` and the
UI labels it "Simulated", so tests and local development run offline."""
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

MAX_OUTPUT_TOKENS = 2000


@dataclass
class ToolCall:
    call_id: str
    name: str
    arguments: dict
    raw_arguments: str = ""
    invalid: bool = False  # the model produced arguments that are not a JSON object


@dataclass
class Turn:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    output_items: list[dict] = field(default_factory=list)  # replayed as input on the next request of the turn
    input_tokens: int = 0  # includes cached input tokens (OpenAI usage semantics)
    cached_tokens: int = 0
    model: str | None = None  # the model that produced this turn (None in simulation)
    output_tokens: int = 0
    simulated: bool = False


class LlmError(Exception):
    """The model could not be reached or failed. The message is safe to show."""


def configured() -> bool:
    return bool(settings.OPENAI_API_KEY)


def model_for(fast: bool = False) -> str:
    return (settings.OPENAI_MODEL_FAST or settings.OPENAI_MODEL) if fast else settings.OPENAI_MODEL


def fast_model() -> str:
    """The cheap default for ordinary turns and lookups (see routing.py)."""
    return settings.OPENAI_MODEL_FAST or settings.OPENAI_MODEL


def smart_model() -> str:
    """The flagship, for building workflows/agents, long multi-step plans and retries after bad output."""
    return settings.OPENAI_MODEL


def function_tools(specs: list[dict]) -> list[dict]:
    """Tool specs ({name, description, parameters}) as Responses API function tools."""
    return [{"type": "function", "name": s["name"], "description": s["description"], "parameters": s["parameters"],
             "strict": False} for s in specs]


_client_override: Any = None  # tests install a fake client here


def _client():
    if _client_override is not None:
        return _client_override
    from openai import OpenAI

    return OpenAI(api_key=settings.OPENAI_API_KEY, timeout=settings.OPENAI_TIMEOUT_SECONDS, max_retries=1)


def _parse_args(raw: str | None) -> tuple[dict, bool]:
    try:
        val = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}, True
    return (val, False) if isinstance(val, dict) else ({}, True)


def _dump(item: Any) -> dict:
    if isinstance(item, dict):
        return item
    return item.model_dump(mode="json", exclude_none=True)


def _turn_from_response(resp: Any) -> Turn:
    turn = Turn()
    texts: list[str] = []
    for item in getattr(resp, "output", None) or []:
        d = _dump(item)
        turn.output_items.append(d)
        if d.get("type") == "function_call":
            args, bad = _parse_args(d.get("arguments"))
            turn.tool_calls.append(ToolCall(d.get("call_id") or d.get("id") or "", d.get("name") or "", args,
                                            d.get("arguments") or "", bad))
        elif d.get("type") == "message":
            for part in d.get("content") or []:
                if part.get("type") == "output_text":
                    texts.append(part.get("text") or "")
    turn.text = "".join(texts)
    usage = getattr(resp, "usage", None)
    if usage is not None:
        turn.input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
        details = getattr(usage, "input_tokens_details", None)
        turn.cached_tokens = int((details.get("cached_tokens") if isinstance(details, dict)
                                  else getattr(details, "cached_tokens", 0)) or 0) if details is not None else 0
        turn.output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
    return turn


def _request(instructions: str, input_items: list[dict], tools: list[dict], fast: bool,
             max_output_tokens: int, model: str | None = None) -> dict:
    req: dict = {"model": model or model_for(fast), "instructions": instructions, "input": list(input_items),
                 "max_output_tokens": max_output_tokens, "store": False,
                 "include": ["reasoning.encrypted_content"]}
    if tools:
        req["tools"] = function_tools(tools)
        req["tool_choice"] = "auto"
    return req


def complete(instructions: str, input_items: list[dict], tools: list[dict] | None = None, *, fast: bool = False,
             max_output_tokens: int = MAX_OUTPUT_TOKENS, model: str | None = None) -> Turn:
    """One model request (no streaming)."""
    req = _request(instructions, input_items, tools or [], fast, max_output_tokens, model)
    try:
        resp = _client().responses.create(**req)
    except Exception as exc:  # noqa: BLE001 - network, auth and API errors all surface the same way
        log.warning("openai_request_failed", error=type(exc).__name__)
        raise LlmError("The AI service is unavailable right now. Please try again in a moment.") from exc
    turn = _turn_from_response(resp)
    turn.model = req["model"]
    return turn


def structured(instructions: str, user_text: str, name: str, schema: dict, *, fast: bool = False,
               model: str | None = None) -> tuple[dict, Turn]:
    """Ask for JSON matching `schema` (Structured Outputs: `text.format` = json_schema in the Responses API)."""
    req = _request(instructions, [{"role": "user", "content": user_text}], [], fast, MAX_OUTPUT_TOKENS, model)
    req["text"] = {"format": {"type": "json_schema", "name": name, "schema": schema, "strict": False}}
    try:
        resp = _client().responses.create(**req)
    except Exception as exc:  # noqa: BLE001
        log.warning("openai_request_failed", error=type(exc).__name__)
        raise LlmError("The AI service is unavailable right now. Please try again in a moment.") from exc
    turn = _turn_from_response(resp)
    turn.model = req["model"]
    try:
        data = json.loads(turn.text or "{}")
    except ValueError as exc:
        raise LlmError("The AI returned something unexpected. Please try again.") from exc
    if not isinstance(data, dict):
        raise LlmError("The AI returned something unexpected. Please try again.")
    return data, turn


def stream(instructions: str, input_items: list[dict], tools: list[dict] | None = None, *,
           max_output_tokens: int = MAX_OUTPUT_TOKENS, model: str | None = None) -> Iterator[tuple[str, Any]]:
    """Stream one model request: yields ("delta", text) while the answer is written, then ("turn", Turn)."""
    req = _request(instructions, input_items, tools or [], False, max_output_tokens, model)
    try:
        events = _client().responses.create(**req, stream=True)
        final = None
        for ev in events:
            kind = getattr(ev, "type", "")
            if kind == "response.output_text.delta":
                yield "delta", getattr(ev, "delta", "") or ""
            elif kind == "response.completed":
                final = getattr(ev, "response", None)
            elif kind in ("response.failed", "error"):
                raise LlmError("The AI service could not answer. Please try again.")
    except LlmError:
        raise
    except Exception as exc:  # noqa: BLE001
        log.warning("openai_stream_failed", error=type(exc).__name__)
        raise LlmError("The AI service is unavailable right now. Please try again in a moment.") from exc
    if final is None:
        raise LlmError("The AI service stopped before finishing. Please try again.")
    turn = _turn_from_response(final)
    turn.model = req["model"]
    yield "turn", turn


# ------------------------------------------------------------------ simulation

Planner = Callable[[str, dict], list[tuple[str, dict]]]


class Simulator:
    """Offline stand-in for the model. `plan(text, hint)` returns the tool calls to make for a request; once
    their results are in, the answer is written from each result's `summary`. Deterministic, so tests can rely
    on it."""

    def __init__(self, plan: Planner, hint: dict | None = None):
        self.plan, self.hint = plan, hint or {}

    def turn(self, input_items: list[dict]) -> Turn:
        # Results of this turn's tool calls are after the last user message.
        last_user = max((i for i, it in enumerate(input_items) if it.get("role") == "user"), default=-1)
        outputs = [it for it in input_items[last_user + 1:] if it.get("type") == "function_call_output"]
        turn = Turn(simulated=True)
        if not outputs:
            text = _content_text(input_items[last_user]) if last_user >= 0 else ""
            calls = self.plan(text, self.hint)
            if calls:
                for i, (name, args) in enumerate(calls):
                    cid = f"sim_{len(input_items)}_{i}"
                    turn.tool_calls.append(ToolCall(cid, name, args, json.dumps(args)))
                    turn.output_items.append({"type": "function_call", "call_id": cid, "name": name,
                                              "arguments": json.dumps(args)})
                return turn
            turn.text = self.hint.get("fallback") or FALLBACK
            return turn
        parts = []
        for o in outputs:
            try:
                data = json.loads(o.get("output") or "{}")
            except ValueError:
                data = {}
            if isinstance(data, dict) and isinstance(data.get("untrusted_data"), dict):
                data = data["untrusted_data"]
            if isinstance(data, dict) and data.get("summary"):
                parts.append(str(data["summary"]))
            elif isinstance(data, dict) and data.get("error"):
                parts.append(f"I couldn't do that: {data['error']}")
        turn.text = "\n\n".join(parts) or "Done."
        return turn

    def stream(self, input_items: list[dict]) -> Iterator[tuple[str, Any]]:
        turn = self.turn(input_items)
        if turn.text:
            words = turn.text.split(" ")
            for i in range(0, len(words), 4):
                yield "delta", " ".join(words[i:i + 4]) + (" " if i + 4 < len(words) else "")
        yield "turn", turn


FALLBACK = ("I'm running in **simulation mode** (no OpenAI key is configured), so I only understand a few kinds "
            "of request. Try “Which deals are stale?”, “How did we do this week?”, “Show my tasks due today”, "
            "“What's my wallet balance?” or “Create a task to call Priya tomorrow”.")


def _content_text(item: dict) -> str:
    c = item.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict))
    return ""

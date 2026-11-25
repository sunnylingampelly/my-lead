"""The AI Team tool registry: typed tools that wrap existing services.

Each tool declares a name, a description, JSON-schema parameters, the permissions it needs and a kind:
* read: runs straight away and returns data;
* write: never runs straight away. It is first *prepared* (arguments checked and resolved, a title and the key
  fields for the confirmation card) and only *executed* after a person confirms it (or, for an AI agent in
  auto mode, after the agent's owner chose to let it act).

Tools always run with the calling person's own AppContext: the same permission checks as the API apply inside
every service the tool calls, and the registry checks the tool's declared permissions first. Tool results are
data, never instructions (see assistant.SYSTEM_PROMPT)."""
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy.orm import Session

from app.core.errors import ValidationFailed
from app.core.permissions import Perm


class ToolError(Exception):
    """A tool can't run (unknown tool, missing permission, refused action, bad arguments). Safe to show."""

    def __init__(self, message: str, code: str = "TOOL_ERROR", link: dict | None = None):
        super().__init__(message)
        self.message, self.code, self.link = message, code, link


@dataclass
class Prepared:
    """A write tool call checked and resolved, ready to show on a confirmation card."""

    args: dict
    title: str
    fields: list[dict] = field(default_factory=list)  # [{"label": ..., "value": ...}]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    perms: tuple[Perm, ...]
    kind: Literal["read", "write"]
    run: Callable[[Session, Any, dict], dict]  # read: the result; write: execute (after confirmation)
    prepare: Callable[[Session, Any, dict], Prepared] | None = None  # write tools only
    label: str = ""  # short human name, e.g. "Create task"
    editable: tuple[str, ...] = ()  # argument names a person may edit on the confirmation card

    def spec(self) -> dict:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


REGISTRY: dict[str, Tool] = {}


def register(tool: Tool) -> Tool:
    if tool.name in REGISTRY:
        raise RuntimeError(f"duplicate tool {tool.name}")
    if tool.kind == "write" and tool.prepare is None:
        raise RuntimeError(f"write tool {tool.name} needs prepare()")
    REGISTRY[tool.name] = tool
    return tool


def obj(properties: dict, required: list[str] | None = None) -> dict:
    return {"type": "object", "properties": properties, "required": required or [], "additionalProperties": False}


def result(summary: str, data: Any = None, links: list[dict] | None = None) -> dict:
    """What a tool returns: `data` for the model, `summary` (markdown) for people and the simulator, `links`
    for deep-link buttons."""
    return {"summary": summary, "data": data, "links": links or []}


def link(label: str, href: str) -> dict:
    return {"label": label[:60], "href": href}


def app_path(ctx, path: str = "") -> str:
    return f"/apps/{ctx.application_id}{path}"


# ------------------------------------------------------------------ argument validation (a JSON-schema subset)

_TYPES = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}


def _check(value: Any, schema: dict, path: str) -> Any:
    t = schema.get("type")
    if t == "integer" and isinstance(value, float) and value.is_integer():
        value = int(value)
    if t == "number" and isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            pass
    if t and not isinstance(value, _TYPES[t]) or (t in ("integer", "number") and isinstance(value, bool)):
        raise ToolError(f"{path or 'arguments'} should be a {t}", "INVALID_ARGUMENTS")
    if "enum" in schema and value not in schema["enum"]:
        raise ToolError(f"{path} must be one of {', '.join(map(str, schema['enum']))}", "INVALID_ARGUMENTS")
    if t == "string":
        if len(value) > schema.get("maxLength", 20000):
            raise ToolError(f"{path} is too long", "INVALID_ARGUMENTS")
        if schema.get("pattern") and not re.fullmatch(schema["pattern"], value):
            raise ToolError(f"{path} is not in the expected format", "INVALID_ARGUMENTS")
    if t in ("integer", "number"):
        if "minimum" in schema and value < schema["minimum"] or "maximum" in schema and value > schema["maximum"]:
            raise ToolError(f"{path} is out of range", "INVALID_ARGUMENTS")
    if t == "array":
        if len(value) > schema.get("maxItems", 500):
            raise ToolError(f"{path} has too many items", "INVALID_ARGUMENTS")
        if "items" in schema:
            value = [_check(v, schema["items"], f"{path}[{i}]") for i, v in enumerate(value)]
    if t == "object" and "properties" in schema:
        value = validate_args(value, schema, path)
    return value


def validate_args(args: Any, schema: dict, path: str = "") -> dict:
    if not isinstance(args, dict):
        raise ToolError("Arguments must be an object", "INVALID_ARGUMENTS")
    props = schema.get("properties", {})
    out = {}
    for k, v in args.items():
        if k not in props:
            continue  # unknown keys are dropped, never passed on
        if v is None:
            continue
        out[k] = _check(v, props[k], f"{path}{k}")
    for k in schema.get("required", []):
        if k not in out:
            raise ToolError(f"Missing {path}{k}", "INVALID_ARGUMENTS")
    return out


def wrap_validation(fn: Callable) -> Callable:
    """Service ValidationFailed / NotFound inside a tool become ToolError with the same message."""
    from app.core.errors import AppError

    def inner(*a, **kw):
        try:
            return fn(*a, **kw)
        except ToolError:
            raise
        except ValidationFailed as exc:
            raise ToolError(exc.message, exc.code) from exc
        except AppError as exc:
            raise ToolError(exc.message, exc.code) from exc

    return inner

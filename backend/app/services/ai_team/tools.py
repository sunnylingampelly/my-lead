"""The AI Team's tools: the registry (registry.py) filled with read tools (tools_read.py) and write tools
(tools_write.py), and the only entry points callers use.

Rules enforced here, for the assistant and for agents alike:
* a tool is offered to the model only if the caller holds every permission it declares (`available`);
* every call is checked again before it runs (`check`), with the caller's own AppContext; the services
  underneath repeat their usual permission checks;
* write tools are never executed by `call`: they are prepared and returned as a proposal that a person
  confirms (actions.py), or executed by an agent in auto mode through `execute` after `prepare`;
* actions that are never available (sending/launching campaigns, deleting, billing, roles, erasure) are refused
  with an explanation of how the person can do it themselves."""
from sqlalchemy.orm import Session

from app.core.permissions import Perm
from app.services.ai_team import guide
from app.services.ai_team import tools_read as _read  # noqa: F401 - registers the read tools
from app.services.ai_team import tools_write as _write  # noqa: F401 - registers the write tools
from app.services.ai_team.registry import (
    REGISTRY,
    Prepared,
    Tool,
    ToolError,
    app_path,
    link,
    validate_args,
    wrap_validation,
)

READ_TOOLS = tuple(n for n, t in REGISTRY.items() if t.kind == "read")
WRITE_TOOLS = tuple(n for n, t in REGISTRY.items() if t.kind == "write")


def get(name: str) -> Tool:
    never = guide.NEVER_TOOL_NAMES.get(name)
    if never:
        raise ToolError(guide.NEVER[never][0], "NEVER_AVAILABLE")
    tool = REGISTRY.get(name)
    if tool is None:
        raise ToolError(f"There is no tool called {name!r}", "UNKNOWN_TOOL")
    return tool


def permitted(ctx, tool: Tool) -> bool:
    return all(ctx.has(p) for p in tool.perms)


def available(ctx, allowed: list[str] | tuple[str, ...] | None = None) -> list[Tool]:
    """Tools this person may use (and, for an agent, that the agent is allowed), in registry order."""
    return [t for n, t in REGISTRY.items() if (allowed is None or n in allowed) and permitted(ctx, t)]


def specs(ctx, allowed=None) -> list[dict]:
    return [t.spec() for t in available(ctx, allowed)]


def check(ctx, name: str, allowed=None) -> Tool:
    tool = get(name)
    if allowed is not None and name not in allowed:
        raise ToolError(f"This agent isn't allowed to use {tool.label or name}", "TOOL_NOT_ALLOWED")
    if not permitted(ctx, tool):
        missing = ", ".join(p.value for p in tool.perms if not ctx.has(p))
        raise ToolError(f"Your role doesn't allow “{tool.label or name}” here (needs {missing}).", "PERMISSION_DENIED")
    return tool


def run_read(db: Session, ctx, name: str, args: dict, allowed=None) -> dict:
    tool = check(ctx, name, allowed)
    if tool.kind != "read":
        raise ToolError("Write tools need confirmation first", "NEEDS_CONFIRMATION")
    return wrap_validation(tool.run)(db, ctx, validate_args(args, tool.parameters))


def prepare(db: Session, ctx, name: str, args: dict, allowed=None) -> Prepared:
    tool = check(ctx, name, allowed)
    if tool.kind != "write":
        raise ToolError("Only write tools are prepared", "NOT_A_WRITE_TOOL")
    return wrap_validation(tool.prepare)(db, ctx, validate_args(args, tool.parameters))


def execute(db: Session, ctx, name: str, prepared_args: dict) -> dict:
    """Run a prepared (and confirmed) write. The permission check is repeated with the executing person's
    context: whoever confirms must be allowed to do it themselves."""
    tool = check(ctx, name)
    if tool.kind != "write":
        raise ToolError("Only write tools are executed", "NOT_A_WRITE_TOOL")
    return wrap_validation(tool.run)(db, ctx, prepared_args)


def refusal(ctx, intent: str) -> dict:
    msg, path = guide.NEVER[intent]
    href = (f"/orgs/{ctx.organization_id}/billing" if path == "billing" else
            f"/orgs/{ctx.organization_id}/team" if path == "team" else app_path(ctx, path))
    return {"summary": msg, "data": {"refused": True}, "links": [link("Open page", href)]}


def catalog(ctx) -> list[dict]:
    """Every tool with whether this person may use it (agent editor and docs)."""
    return [{"name": n, "label": t.label or n, "description": t.description, "kind": t.kind,
             "permissions": [p.value for p in t.perms], "allowed": permitted(ctx, t)} for n, t in REGISTRY.items()]


__all__ = ["READ_TOOLS", "WRITE_TOOLS", "Perm", "Prepared", "ToolError", "available", "catalog", "check", "execute",
           "get", "prepare", "refusal", "run_read", "specs"]

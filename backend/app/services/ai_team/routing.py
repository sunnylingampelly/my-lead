"""Which OpenAI model handles a call.

* Default: OPENAI_MODEL_FAST (gpt-6-luna) for ordinary assistant turns and lookups.
* Escalate to OPENAI_MODEL (gpt-6.2-astra) only for complex work:
  - the person asks to build/create a workflow or an agent (and "Describe what you want" drafting);
  - multi-step planning: from the third round of tool calls on;
  - a fast-model turn produced output that failed validation (one retry on the flagship).
* Agents: templates that research, score or write (lead qualifier, chat follow-up drafter) and custom agents
  that may change data run on the flagship; report, digest and alert agents run on the fast model.
The model used is stored with every call (assistant messages and agent run steps)."""
import re

from app.services.ai_team import llm

BUILD_INTENT = re.compile(r"\b(create|build|make|set ?up|design|draft|automate)\b.*\b(workflow|automation|journey|agent)s?\b",
                          re.I)
ESCALATE_AFTER_ROUNDS = 2
SMART_TEMPLATES = {"lead_qualifier", "chat_followup"}
FAST_TEMPLATES = {"hot_lead_alert", "stale_deal_watchdog", "daily_report", "weekly_campaign_report",
                  "balance_alert", "unanswered_digest"}


def needs_flagship(text: str) -> bool:
    return bool(BUILD_INTENT.search(text or ""))


def assistant_model(text: str, round_idx: int, retry: bool = False) -> str:
    """round_idx: 0 for the first model call of a message, 1 after the first round of tool calls, ..."""
    if retry or needs_flagship(text) or round_idx >= ESCALATE_AFTER_ROUNDS:
        return llm.smart_model()
    return llm.fast_model()


def agent_model(agent, round_idx: int, retry: bool = False) -> str:
    if retry or round_idx >= ESCALATE_AFTER_ROUNDS:
        return llm.smart_model()
    if agent.template in SMART_TEMPLATES:
        return llm.smart_model()
    if agent.template in FAST_TEMPLATES:
        return llm.fast_model()
    from app.services.ai_team.registry import REGISTRY

    writes = any(REGISTRY[t].kind == "write" for t in agent.allowed_tools or [] if t in REGISTRY)
    return llm.smart_model() if writes else llm.fast_model()


def bad_output(turn, errors: list[str]) -> bool:
    """True when a turn's tool calls failed validation (bad JSON or invalid arguments)."""
    return any(c.invalid for c in turn.tool_calls) or any(e == "INVALID_ARGUMENTS" for e in errors)

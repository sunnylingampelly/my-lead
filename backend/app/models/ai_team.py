"""AI Team: the in-app AI Assistant (conversations, messages and the write actions it proposes), autonomous
AI agents (configuration, runs and their steps), the organization's Slack connection with per-agent Slack
destinations, and per-organization daily usage counters for the plan's fair-use limits.

Every table is tenant-scoped. Tool calls and results are stored as JSON text (JSONText) because they can be
deeply nested."""
from datetime import date, datetime

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, JSONText, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class AssistantConversation(TenantMixin, TimestampMixin, Base):
    """One chat thread with the AI Assistant. Private to its user, per application."""

    __tablename__ = "ai_conversations"
    __table_args__ = (Index("ix_ai_conversations_user_app", "user_id", "application_id", "updated_at"),)

    id: Mapped[str] = uuid_pk()
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False, default="New chat")
    message_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class AssistantMessage(TenantMixin, Base):
    """role: user | assistant. `tool_calls` keeps the tools the assistant used to answer (name, arguments, short
    result) and `links` the deep links shown as buttons; `context` is the page the user was on."""

    __tablename__ = "ai_messages"
    __table_args__ = (Index("ix_ai_messages_conversation", "conversation_id", "created_at"),)

    id: Mapped[str] = uuid_pk()
    conversation_id: Mapped[str] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String(12), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default="")
    tool_calls: Mapped[list | None] = mapped_column(JSONText(), nullable=True)
    links: Mapped[list | None] = mapped_column(JSONText(), nullable=True)
    context: Mapped[dict | None] = mapped_column(JSONText(), nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Metering (assistant replies): models used, cached input tokens, provider cost and the wallet charge.
    model: Mapped[str | None] = mapped_column(String(200), nullable=True)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(14, 8), nullable=False, default=0)
    charge_amount: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)
    charge_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class AiPendingAction(TenantMixin, TimestampMixin, Base):
    """A write tool call proposed by the assistant or an agent, waiting for a person to confirm it.

    status: pending → executing → executed | failed; or pending → cancelled (by its user) | rejected (by an
    approver) | expired. Moving out of `pending` is a single conditional UPDATE, so a double click, two
    approvers or a Slack retry can never execute it twice."""

    __tablename__ = "ai_pending_actions"
    __table_args__ = (Index("ix_ai_actions_app_status", "application_id", "status", "created_at"),
                      Index("ix_ai_actions_conversation", "conversation_id"),
                      Index("ix_ai_actions_run", "run_id"))

    id: Mapped[str] = uuid_pk()
    source: Mapped[str] = mapped_column(String(12), nullable=False)  # assistant|agent
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("ai_conversations.id", ondelete="CASCADE"),
                                                        nullable=True)
    agent_id: Mapped[str | None] = mapped_column(ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("ai_agent_runs.id", ondelete="CASCADE"), nullable=True)
    tool: Mapped[str] = mapped_column(String(60), nullable=False)
    args: Mapped[dict] = mapped_column(JSONText(), nullable=False, default=dict)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    fields: Mapped[list] = mapped_column(JSONText(), nullable=False, default=list)  # [{label, value}]
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    result: Mapped[dict | None] = mapped_column(JSONText(), nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    decided_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    decided_via: Mapped[str | None] = mapped_column(String(12), nullable=True)  # app|slack
    decided_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    slack_channel: Mapped[str | None] = mapped_column(String(40), nullable=True)
    slack_ts: Mapped[str | None] = mapped_column(String(40), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class AiAgent(TenantMixin, TimestampMixin, Base):
    """An autonomous agent. It runs as `owner_id` (with that person's permissions at run time), limited to
    `allowed_tools`. trigger = {"type": "event", "event": "form_submitted", "filters": {...}} or
    {"type": "schedule", "every": "daily"|"weekly"|"hours", "time": "10:00", "day": 0-6, "hours": N}.
    destinations = {"in_app": bool, "email_user_ids": [...]}; Slack channels live in ai_agent_slack_destinations."""

    __tablename__ = "ai_agents"
    __table_args__ = (Index("ix_ai_agents_app_enabled", "application_id", "enabled"),
                      Index("ix_ai_agents_due", "enabled", "next_run_at"))

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    template: Mapped[str | None] = mapped_column(String(40), nullable=True)
    instructions: Mapped[str] = mapped_column(Text, nullable=False, default="")
    trigger: Mapped[dict] = mapped_column(JSONText(), nullable=False, default=dict)
    allowed_tools: Mapped[list] = mapped_column(JSONText(), nullable=False, default=list)
    mode: Mapped[str] = mapped_column(String(10), nullable=False, default="approve")  # auto|approve
    destinations: Mapped[dict] = mapped_column(JSONText(), nullable=False, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    next_run_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    event_cursor: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    last_status: Mapped[str | None] = mapped_column(String(12), nullable=True)
    # Runs pause while the wallet can't pay; owners are told at most once a day.
    wallet_paused_notified_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)


class AgentRun(TenantMixin, Base):
    """One execution of an agent. Unique per (agent, trigger_key) so an event or a schedule slot runs once.
    status: queued → running → completed | failed | skipped; dry runs simulate every write tool."""

    __tablename__ = "ai_agent_runs"
    __table_args__ = (UniqueConstraint("agent_id", "trigger_key", name="uq_ai_agent_runs_agent_key"),
                      Index("ix_ai_agent_runs_agent_time", "agent_id", "created_at"),
                      Index("ix_ai_agent_runs_due", "status", "next_attempt_at"))

    id: Mapped[str] = uuid_pk()
    agent_id: Mapped[str] = mapped_column(ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False)
    trigger_key: Mapped[str] = mapped_column(String(160), nullable=False)
    trigger_data: Mapped[dict] = mapped_column(JSONText(), nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="queued")
    dry_run: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_attempt_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    error: Mapped[str | None] = mapped_column(String(500), nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    models: Mapped[str | None] = mapped_column(String(200), nullable=True)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(14, 8), nullable=False, default=0)
    charge_amount: Mapped[float | None] = mapped_column(Numeric(14, 4), nullable=True)
    charge_currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    started_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class AgentRunStep(TenantMixin, Base):
    """kind: tool (a tool call and its result), proposed (a write waiting for approval), message (the model's
    final text), deliver (posted to a destination), error."""

    __tablename__ = "ai_agent_run_steps"
    __table_args__ = (Index("ix_ai_agent_run_steps_run", "run_id", "position"),)

    id: Mapped[str] = uuid_pk()
    run_id: Mapped[str] = mapped_column(ForeignKey("ai_agent_runs.id", ondelete="CASCADE"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    kind: Mapped[str] = mapped_column(String(12), nullable=False)
    tool: Mapped[str | None] = mapped_column(String(60), nullable=True)
    args: Mapped[dict | None] = mapped_column(JSONText(), nullable=True)
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="done")  # done|simulated|pending|failed
    action_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(14, 8), nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class SlackConnection(TimestampMixin, Base):
    """The organization's Slack workspace (one per organization). The bot token is encrypted at rest; a
    simulated connection (no Slack app configured) logs messages to the development Slack log."""

    __tablename__ = "slack_connections"
    __table_args__ = (Index("ix_slack_connections_team", "team_id"),)

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False,
                                                 unique=True)
    team_id: Mapped[str] = mapped_column(String(40), nullable=False)
    team_name: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    bot_user_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    app_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    scopes: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    connected_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class AgentSlackDestination(TenantMixin, Base):
    """A Slack channel an agent posts its results (and approval requests) to."""

    __tablename__ = "ai_agent_slack_destinations"
    __table_args__ = (UniqueConstraint("agent_id", "channel_id", name="uq_ai_agent_slack_agent_channel"),)

    id: Mapped[str] = uuid_pk()
    agent_id: Mapped[str] = mapped_column(ForeignKey("ai_agents.id", ondelete="CASCADE"), nullable=False)
    channel_id: Mapped[str] = mapped_column(String(40), nullable=False)
    channel_name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)


class AiUsageCounter(Base):
    """Fair-use counters per organization per UTC day. kind: assistant_messages | agent_runs."""

    __tablename__ = "ai_usage_counters"
    __table_args__ = (UniqueConstraint("organization_id", "day", "kind", name="uq_ai_usage_org_day_kind"),)

    id: Mapped[str] = uuid_pk()
    organization_id: Mapped[str] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    day: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

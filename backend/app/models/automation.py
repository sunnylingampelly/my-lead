"""Automation: workflows (React Flow graphs), enrollments (runs) and their step history."""
from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.audience import TenantMixin
from app.models.base import Base, TimestampMixin, UTCDateTime, uuid_pk
from app.utils.time import utcnow


class Workflow(TenantMixin, TimestampMixin, Base):
    __tablename__ = "workflows"
    __table_args__ = (Index("ix_workflows_app_status", "application_id", "status"),)

    id: Mapped[str] = uuid_pk()
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")  # draft|active|paused|archived
    # Editable graph in React Flow shape: {"nodes": [...], "edges": [...]}.
    graph: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    # The graph runs execute; replaced only when changes are published.
    published_graph: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    has_unpublished_changes: Mapped[bool] = mapped_column(nullable=False, default=False)
    # node id → hidden campaign id used to send that node's email / SMS / call.
    node_campaigns: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    allow_reentry: Mapped[bool] = mapped_column(nullable=False, default=False)
    trigger_cursor: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    activated_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    created_by_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class WorkflowRun(TenantMixin, Base):
    """One contact's journey through a workflow."""

    __tablename__ = "workflow_runs"
    __table_args__ = (
        UniqueConstraint("workflow_id", "contact_id", "trigger_key", name="uq_workflow_runs_enrollment"),
        Index("ix_workflow_runs_due", "status", "wake_at"),
        Index("ix_workflow_runs_workflow_status", "workflow_id", "status"),
    )

    id: Mapped[str] = uuid_pk()
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False)
    contact_id: Mapped[str | None] = mapped_column(ForeignKey("contacts.id", ondelete="SET NULL"), nullable=True)
    trigger_key: Mapped[str] = mapped_column(String(120), nullable=False)
    # waiting (due at wake_at) | running (claimed) | completed | exited | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="waiting")
    current_node_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    wake_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    exit_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    steps_taken: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow, onupdate=utcnow)


class WorkflowStep(TenantMixin, Base):
    """Audit trail of what happened at each node for each run."""

    __tablename__ = "workflow_steps"
    __table_args__ = (Index("ix_workflow_steps_run", "run_id", "created_at"),
                      Index("ix_workflow_steps_node", "workflow_id", "node_id", "outcome"))

    id: Mapped[str] = uuid_pk()
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"), nullable=False)
    run_id: Mapped[str] = mapped_column(ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    node_type: Mapped[str] = mapped_column(String(30), nullable=False)
    # entered|done|waiting|skipped|failed|branch_yes|branch_no|branch_a|branch_b
    outcome: Mapped[str] = mapped_column(String(20), nullable=False)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Links to what the step created, e.g. {"task_id": ..., "deal_id": ...}.
    meta: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False, default=utcnow)

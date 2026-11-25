"""ai_metering: metered wallet billing for the AI Team. Models used, cached input tokens, provider cost and the
wallet charge on assistant messages, agent runs and run steps; when an agent last told its owner it paused for
an empty wallet

Revision ID: 0026
Revises: 0025
Create Date: 2026-11-25 22:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

import app.models.base

revision: str = '0026'
down_revision: str | None = '0025'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UTC = app.models.base.UTCDateTime


def _metered(table: str, model_col: str, model_len: int, charge: bool) -> None:
    op.add_column(table, sa.Column(model_col, sa.String(length=model_len), nullable=True))
    op.add_column(table, sa.Column('cached_tokens', sa.Integer(), nullable=False, server_default='0'))
    op.add_column(table, sa.Column('cost_usd', sa.Numeric(14, 8), nullable=False, server_default='0'))
    if charge:
        op.add_column(table, sa.Column('charge_amount', sa.Numeric(14, 4), nullable=True))
        op.add_column(table, sa.Column('charge_currency', sa.String(length=3), nullable=True))


def upgrade() -> None:
    _metered('ai_messages', 'model', 200, True)
    _metered('ai_agent_runs', 'models', 200, True)
    _metered('ai_agent_run_steps', 'model', 120, False)
    op.add_column('ai_agents', sa.Column('wallet_paused_notified_at', UTC(), nullable=True))


def downgrade() -> None:
    op.drop_column('ai_agents', 'wallet_paused_notified_at')
    for table, model_col, charge in (('ai_agent_run_steps', 'model', False), ('ai_agent_runs', 'models', True),
                                     ('ai_messages', 'model', True)):
        if charge:
            op.drop_column(table, 'charge_currency')
            op.drop_column(table, 'charge_amount')
        op.drop_column(table, 'cost_usd')
        op.drop_column(table, 'cached_tokens')
        op.drop_column(table, model_col)

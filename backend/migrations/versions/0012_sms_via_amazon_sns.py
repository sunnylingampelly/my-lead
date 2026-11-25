"""SMS via Amazon SNS: move MSG91 and Twilio SMS senders to SNS, drop the Twilio Messaging Service ID

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-18 18:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0012'
down_revision: str | None = '0011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("UPDATE sms_sender_settings SET provider = 'sns' WHERE provider IN ('msg91', 'twilio')")
    op.execute("UPDATE application_settings SET default_sms_provider = 'sns' WHERE default_sms_provider IN ('msg91', 'twilio')")
    op.drop_column('sms_dlt_configurations', 'us_messaging_service_sid')


def downgrade() -> None:
    op.add_column('sms_dlt_configurations',
                  sa.Column('us_messaging_service_sid', sa.String(length=64), nullable=True))
    # Senders stay on 'sns': which provider each one used before cannot be recovered.

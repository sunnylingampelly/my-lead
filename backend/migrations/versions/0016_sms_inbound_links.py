"""sms inbound: link replies to the contact and the campaign they answer

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-19 09:00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0016'
down_revision: str | None = '0015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sms_inbound", sa.Column("contact_id", sa.String(36), nullable=True))
    op.add_column("sms_inbound", sa.Column("campaign_id", sa.String(36), nullable=True))
    op.create_index("ix_sms_inbound_contact", "sms_inbound", ["contact_id", "received_at"])
    op.create_index("ix_sms_inbound_campaign", "sms_inbound", ["campaign_id", "keyword"])
    op.create_foreign_key("fk_sms_inbound_contact", "sms_inbound", "contacts", ["contact_id"], ["id"],
                          ondelete="SET NULL")
    op.create_foreign_key("fk_sms_inbound_campaign", "sms_inbound", "sms_campaigns", ["campaign_id"], ["id"],
                          ondelete="SET NULL")
    # Back-fill existing replies: the contact with that number, and the last campaign that texted it.
    op.execute("""
        UPDATE sms_inbound i
        SET i.contact_id = (SELECT c.id FROM contacts c
                            WHERE c.application_id = i.application_id AND c.phone = i.from_phone
                            ORDER BY c.created_at LIMIT 1)
    """)
    op.execute("""
        UPDATE sms_inbound i
        SET i.campaign_id = (SELECT m.campaign_id FROM sms_messages m
                             WHERE m.application_id = i.application_id AND m.to_phone = i.from_phone
                               AND m.created_at <= i.received_at
                             ORDER BY m.created_at DESC LIMIT 1)
    """)


def downgrade() -> None:
    # MySQL: drop the foreign keys before the indexes they rely on.
    op.drop_constraint("fk_sms_inbound_campaign", "sms_inbound", type_="foreignkey")
    op.drop_constraint("fk_sms_inbound_contact", "sms_inbound", type_="foreignkey")
    op.drop_index("ix_sms_inbound_campaign", table_name="sms_inbound")
    op.drop_index("ix_sms_inbound_contact", table_name="sms_inbound")
    op.drop_column("sms_inbound", "campaign_id")
    op.drop_column("sms_inbound", "contact_id")

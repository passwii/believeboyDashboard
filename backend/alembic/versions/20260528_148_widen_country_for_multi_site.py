"""Widen country column for multi-site subscriptions.

Revision ID: 148
Down Revision: 147
"""

from alembic import op
import sqlalchemy as sa

revision: str = "148"
down_revision: str = "147"


def upgrade() -> None:
    op.alter_column(
        "scheduled_report_subscriptions", "country",
        existing_type=sa.String(10), type_=sa.String(256),
    )
    op.alter_column(
        "scheduled_report_ledger_entries", "country",
        existing_type=sa.String(10), type_=sa.String(256),
    )


def downgrade() -> None:
    op.alter_column(
        "scheduled_report_subscriptions", "country",
        existing_type=sa.String(256), type_=sa.String(10),
    )
    op.alter_column(
        "scheduled_report_ledger_entries", "country",
        existing_type=sa.String(256), type_=sa.String(10),
    )

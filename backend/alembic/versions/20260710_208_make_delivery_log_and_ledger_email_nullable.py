"""Make delivery_log and ledger_entry email columns nullable

Revision ID: 20260710_208
Revises: 20260710_207

Follow-up to 20260710_206: subscriptions.email was made nullable so a
subscription may have no recipient address. The same email value is
snapshotted onto each delivery_log row and each ledger entry; both
columns must therefore also accept NULL.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260710_208"
down_revision = "20260710_207"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "scheduled_report_delivery_logs",
        "email",
        existing_type=sa.String(length=256),
        nullable=True,
    )
    op.alter_column(
        "scheduled_report_ledger_entries",
        "email",
        existing_type=sa.String(length=256),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "scheduled_report_ledger_entries",
        "email",
        existing_type=sa.String(length=256),
        nullable=False,
    )
    op.alter_column(
        "scheduled_report_delivery_logs",
        "email",
        existing_type=sa.String(length=256),
        nullable=False,
    )
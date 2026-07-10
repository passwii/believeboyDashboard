"""Make scheduled_report_subscriptions.email nullable

Revision ID: 20260710_206
Revises: 20260708_205
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260710_206"
down_revision = "20260708_205"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "scheduled_report_subscriptions",
        "email",
        existing_type=sa.String(length=256),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "scheduled_report_subscriptions",
        "email",
        existing_type=sa.String(length=256),
        nullable=False,
    )

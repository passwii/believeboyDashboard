"""Add screenshot thumb fields to scheduled_report_delivery_logs.

Revision ID: 146
Revises: 145
Create Date: 2026-05-25 16:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "146"
down_revision: str = "145"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column(
        "scheduled_report_delivery_logs",
        sa.Column("screenshot_r2_thumb_key", sa.String(512), nullable=True),
    )
    op.add_column(
        "scheduled_report_delivery_logs",
        sa.Column("screenshot_r2_thumb_url", sa.String(1024), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("scheduled_report_delivery_logs", "screenshot_r2_thumb_url")
    op.drop_column("scheduled_report_delivery_logs", "screenshot_r2_thumb_key")
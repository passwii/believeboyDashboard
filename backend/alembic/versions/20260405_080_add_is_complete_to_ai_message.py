"""add_is_complete_to_ai_message

Revision ID: 20260405_080
Revises: 20260331_079
Create Date: 2026-04-05 10:20:00.000000

"""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260405_080"
down_revision: str = "20260331_079"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_messages",
        sa.Column("is_complete", sa.Boolean(), server_default="false", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("ai_messages", "is_complete")

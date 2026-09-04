"""add_token_usage_to_ai_message

Revision ID: 20260405_081
Revises: 20260405_080
Create Date: 2026-04-05 13:35:00.000000

"""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260405_081"
down_revision: str = "20260405_080"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "ai_messages",
        sa.Column("prompt_tokens", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "ai_messages",
        sa.Column(
            "completion_tokens", sa.Integer(), server_default="0", nullable=False
        ),
    )
    op.add_column(
        "ai_messages",
        sa.Column("total_tokens", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column(
        "ai_messages",
        sa.Column("duration_ms", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ai_messages", "duration_ms")
    op.drop_column("ai_messages", "total_tokens")
    op.drop_column("ai_messages", "completion_tokens")
    op.drop_column("ai_messages", "prompt_tokens")

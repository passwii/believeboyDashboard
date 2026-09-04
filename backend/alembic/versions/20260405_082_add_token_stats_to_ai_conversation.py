"""add token stats to ai_conversation

Revision ID: add_token_stats_conv
Revises: 20260405_081
Create Date: 2026-04-05 21:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "add_token_stats_conv"
down_revision: Union[str, None] = "20260405_081"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ai_conversations",
        sa.Column(
            "total_prompt_tokens", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.add_column(
        "ai_conversations",
        sa.Column(
            "total_completion_tokens", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.add_column(
        "ai_conversations",
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("ai_conversations", "total_tokens")
    op.drop_column("ai_conversations", "total_completion_tokens")
    op.drop_column("ai_conversations", "total_prompt_tokens")

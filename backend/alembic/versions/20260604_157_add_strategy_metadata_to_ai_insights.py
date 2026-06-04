"""add strategy_metadata to ai_insights

为 ai_insights 表新增 strategy_metadata 列，用于持久化分析策略元数据。

Revision ID: 157
Revises: 156
Create Date: 2026-06-04
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "157"
down_revision = "156"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_insights", sa.Column("strategy_metadata", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("ai_insights", "strategy_metadata")

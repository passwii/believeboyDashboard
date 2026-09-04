"""Add insight_schedules table for AI Insight scheduled generation

Revision ID: 125
Revises: 124
Create Date: 2026-05-18
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import func

revision = "125"
down_revision = "20260518_124"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "insight_schedules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "project_id",
            sa.Integer(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("country", sa.String(2), nullable=False, server_default="US"),
        sa.Column("insight_type", sa.String(32), nullable=False, server_default="daily"),
        sa.Column("cron_expression", sa.String(64), nullable=False),
        sa.Column(
            "date_range_strategy",
            sa.String(32),
            nullable=False,
            server_default="yesterday",
        ),
        sa.Column("model", sa.String(64), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_by", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=func.now(),
        ),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_insight_id", sa.Integer(), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("run_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "failure_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 创建索引
    op.create_index("idx_schedule_active", "insight_schedules", ["is_active"])
    op.create_index("idx_schedule_project", "insight_schedules", ["project_id"])


def downgrade() -> None:
    op.drop_index("idx_schedule_project", table_name="insight_schedules")
    op.drop_index("idx_schedule_active", table_name="insight_schedules")
    op.drop_table("insight_schedules")
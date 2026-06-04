"""add ad_agent_evolution_tables

为 Ad Agent 进化引擎提供持久化存储：
- ad_agent_runs: 记录每次 Agent Pipeline 的运行元数据
- ad_agent_dimension_health: 追踪每个维度在每次运行中的信号强度

Revision ID: 156
Revises: 155
Create Date: 2026-06-04
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "156"
down_revision = "155"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ad_agent_runs",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, nullable=False),
        sa.Column("run_id", sa.String(100), nullable=False),
        sa.Column("insight_id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), nullable=True),
        sa.Column("project_id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), nullable=False),
        sa.Column("project_name", sa.String(255), nullable=False),
        sa.Column("country", sa.String(2), nullable=False),
        sa.Column("date_range_start", sa.Date(), nullable=True),
        sa.Column("date_range_end", sa.Date(), nullable=True),
        sa.Column("dimensions_analyzed", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("cross_analyses_performed", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("temporal_analyses_performed", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("dimensions_skipped", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("data_source_signals", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("quality_signals", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("prompt_version", sa.String(20), nullable=False, server_default="v2"),
        sa.Column("user_feedback", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id"),
    )
    op.create_index("ix_ad_agent_runs_project_id", "ad_agent_runs", ["project_id"])

    op.create_table(
        "ad_agent_dimension_health",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, nullable=False),
        sa.Column("dimension_id", sa.String(100), nullable=False),
        sa.Column("run_id", sa.String(100), nullable=False),
        sa.Column("signal_strength", sa.String(20), nullable=False),
        sa.Column("was_analyzed", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("skip_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_ad_agent_dimension_health_dimension_id", "ad_agent_dimension_health", ["dimension_id"])
    op.create_index("ix_ad_agent_dimension_health_run_id", "ad_agent_dimension_health", ["run_id"])
    op.create_index("idx_dim_health_dimension_run", "ad_agent_dimension_health", ["dimension_id", "run_id"])


def downgrade() -> None:
    op.drop_index("idx_dim_health_dimension_run", table_name="ad_agent_dimension_health")
    op.drop_index("ix_ad_agent_dimension_health_run_id", table_name="ad_agent_dimension_health")
    op.drop_index("ix_ad_agent_dimension_health_dimension_id", table_name="ad_agent_dimension_health")
    op.drop_table("ad_agent_dimension_health")
    op.drop_index("ix_ad_agent_runs_project_id", table_name="ad_agent_runs")
    op.drop_table("ad_agent_runs")

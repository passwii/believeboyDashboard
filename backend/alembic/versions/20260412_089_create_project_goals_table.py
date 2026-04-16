"""Create project_goals table

Revision ID: 20260412_089
Revises: 20260410_088
Create Date: 2026-04-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260412_089'
down_revision: Union[str, None] = '20260410_088'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'project_goals',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('country', sa.String(length=10), server_default='US', nullable=False),
        sa.Column('goal_type', sa.String(length=20), nullable=False),
        sa.Column('metric_type', sa.String(length=30), server_default='sales_amount', nullable=False),
        sa.Column('period_year', sa.Integer(), nullable=False),
        sa.Column('period_month', sa.Integer(), nullable=True),
        sa.Column('target_amount', sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.UniqueConstraint(
            'project_id', 'country', 'goal_type', 'metric_type', 'period_year', 'period_month',
            name='project_goals_unique_period',
        ),
        sa.CheckConstraint(
            "goal_type IN ('monthly', 'annual')",
            name='project_goals_goal_type_check',
        ),
        sa.CheckConstraint(
            "metric_type = 'sales_amount'",
            name='project_goals_metric_type_check',
        ),
        sa.CheckConstraint(
            "country IN ('US', 'DE', 'UK')",
            name='project_goals_country_check',
        ),
        sa.CheckConstraint(
            'period_month IS NULL OR (period_month >= 1 AND period_month <= 12)',
            name='project_goals_month_check',
        ),
        sa.CheckConstraint(
            'target_amount >= 0',
            name='project_goals_target_amount_check',
        ),
    )
    op.create_index(
        'idx_project_goals_project_year',
        'project_goals',
        ['project_id', 'period_year'],
    )


def downgrade() -> None:
    op.drop_index('idx_project_goals_project_year', table_name='project_goals')
    op.drop_table('project_goals')

"""Add metric_type to project_goals

Revision ID: 20260412_090
Revises: 20260412_089
Create Date: 2026-04-12
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260412_090'
down_revision: Union[str, None] = '20260412_089'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # metric_type column and project_goals_metric_type_check already exist from 20260412_089
    # Only update unique constraint to include metric_type
    op.drop_constraint(
        'project_goals_unique_period',
        'project_goals',
        type_='unique',
    )
    op.create_unique_constraint(
        'project_goals_unique_period',
        'project_goals',
        ['project_id', 'country', 'goal_type', 'metric_type', 'period_year', 'period_month'],
    )



def downgrade() -> None:
    # metric_type column and check constraint belong to 089, not 090
    # Only revert the unique constraint change
    op.drop_constraint(
        'project_goals_unique_period',
        'project_goals',
        type_='unique',
    )
    op.create_unique_constraint(
        'project_goals_unique_period',
        'project_goals',
        ['project_id', 'country', 'goal_type', 'period_year', 'period_month'],
    )

"""Add AIInsight table for persistent AI insights

Revision ID: 20260410_086
Revises: 20260410_085
Create Date: 2026-04-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260410_086'
down_revision: Union[str, None] = '20260410_085'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create ai_insights table
    op.create_table(
        'ai_insights',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.BigInteger(), nullable=False),
        sa.Column('project_name', sa.String(length=255), nullable=False),
        sa.Column('country', sa.String(length=2), server_default='US', nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('content', sa.Text(), nullable=False),
        sa.Column('insight_type', sa.String(length=32), nullable=False),
        sa.Column('date_range_start', sa.Date(), nullable=False),
        sa.Column('date_range_end', sa.Date(), nullable=False),
        sa.Column('status', sa.String(length=16), server_default='pending', nullable=False),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('created_by', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
    )
    op.create_index('idx_ai_insights_project_id', 'ai_insights', ['project_id'])
    op.create_index('idx_ai_insights_project_country', 'ai_insights', ['project_id', 'country'])
    op.create_index('idx_ai_insights_created_at', 'ai_insights', ['created_at'])
    op.create_index('idx_ai_insights_status', 'ai_insights', ['status'])


def downgrade() -> None:
    op.drop_index('idx_ai_insights_status', 'ai_insights')
    op.drop_index('idx_ai_insights_created_at', 'ai_insights')
    op.drop_index('idx_ai_insights_project_country', 'ai_insights')
    op.drop_index('idx_ai_insights_project_id', 'ai_insights')
    op.drop_table('ai_insights')

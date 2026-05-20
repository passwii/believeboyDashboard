"""add platform_revenues table

Revision ID: 127
Revises: 126
Create Date: 2026-05-20 12:15:21.325021
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '127'
down_revision: Union[str, None] = '126'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'platform_revenues',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), primary_key=True, autoincrement=True, nullable=False),
        sa.Column('project_id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_name', sa.String(length=255), nullable=False),
        sa.Column('country', sa.String(length=10), nullable=False),
        sa.Column('received_date', sa.Date(), nullable=False),
        sa.Column('amount', sa.Numeric(precision=15, scale=2), nullable=False),
        sa.Column('currency', sa.String(length=10), nullable=False, server_default='USD'),
        sa.Column('exchange_rate', sa.Numeric(precision=15, scale=6), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('attachments', sa.JSON(), nullable=False, server_default='[]'),
        sa.Column('created_by', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
    )
    op.create_index('ix_platform_revenues_project_id', 'platform_revenues', ['project_id'], unique=False)
    op.create_index('ix_platform_revenues_received_date', 'platform_revenues', ['received_date'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_platform_revenues_received_date', table_name='platform_revenues')
    op.drop_index('ix_platform_revenues_project_id', table_name='platform_revenues')
    op.drop_table('platform_revenues')
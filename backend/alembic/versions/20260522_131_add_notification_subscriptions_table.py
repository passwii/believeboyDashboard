"""add notification_subscriptions table

Revision ID: 131
Revises: 130
Create Date: 2026-05-22 00:04:04.511486
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '131'
down_revision: Union[str, None] = '130'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'notification_subscriptions',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('project_id', sa.Integer(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('rule_name', sa.String(128), nullable=False),
        sa.Column('frequency', sa.String(20), nullable=False),
        sa.Column('report_types', postgresql.JSON(), nullable=False, server_default='[]'),
        sa.Column('recipients', postgresql.JSON(), nullable=False, server_default='[]'),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.text('now()')),
    )
    op.create_index('idx_ns_project', 'notification_subscriptions', ['project_id'])
    op.create_index('idx_ns_frequency', 'notification_subscriptions', ['frequency'])


def downgrade() -> None:
    op.drop_index('idx_ns_frequency', table_name='notification_subscriptions')
    op.drop_index('idx_ns_project', table_name='notification_subscriptions')
    op.drop_table('notification_subscriptions')

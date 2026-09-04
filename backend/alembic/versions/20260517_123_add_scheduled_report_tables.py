"""add scheduled report tables

Revision ID: 20260517_123
Revises: 20260517_122
Create Date: 2026-05-17 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260517_123'
down_revision: Union[str, None] = '20260517_122'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'scheduled_report_subscriptions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('email', sa.String(length=256), nullable=False),
        sa.Column('project_ids', sa.String(length=500), nullable=False, server_default='*'),
        sa.Column('country', sa.String(length=10), nullable=False, server_default='US'),
        sa.Column('frequency', sa.String(length=20), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_scheduled_report_subs_user_id', 'scheduled_report_subscriptions', ['user_id'])
    op.create_index('ix_scheduled_report_subs_frequency', 'scheduled_report_subscriptions', ['frequency', 'enabled'])

    op.create_table(
        'scheduled_report_delivery_logs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('subscription_id', sa.Integer(), nullable=False),
        sa.Column('frequency', sa.String(length=20), nullable=False),
        sa.Column('report_date', sa.String(length=20), nullable=False),
        sa.Column('report_month', sa.String(length=10), nullable=True),
        sa.Column('email', sa.String(length=256), nullable=False),
        sa.Column('status', sa.String(length=20), nullable=False, server_default='pending'),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['subscription_id'], ['scheduled_report_subscriptions.id'], ondelete='CASCADE'),
    )
    op.create_index('ix_delivery_logs_subscription', 'scheduled_report_delivery_logs', ['subscription_id'])
    op.create_index('ix_delivery_logs_report_date', 'scheduled_report_delivery_logs', ['report_date'])


def downgrade() -> None:
    op.drop_table('scheduled_report_delivery_logs')
    op.drop_table('scheduled_report_subscriptions')

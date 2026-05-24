"""Add scheduled report ledger entries.

Revision ID: 142
Revises: 141
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = '142'
down_revision = '141'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'scheduled_report_ledger_entries',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('ledger_key', sa.String(64), nullable=False),
        sa.Column('subscription_id', sa.Integer(), nullable=False),
        sa.Column('frequency', sa.String(20), nullable=False),
        sa.Column('expected_date', sa.String(20), nullable=False),
        sa.Column('expected_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('email', sa.String(256), nullable=False),
        sa.Column('project_ids', sa.String(500), nullable=False, server_default='*'),
        sa.Column('country', sa.String(10), nullable=False, server_default='US'),
        sa.Column('status', sa.String(20), nullable=False, server_default='missing'),
        sa.Column('latest_delivery_log_id', sa.Integer(), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('sent_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('last_checked_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(['subscription_id'], ['scheduled_report_subscriptions.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['latest_delivery_log_id'], ['scheduled_report_delivery_logs.id'], ondelete='SET NULL'),
        sa.UniqueConstraint('ledger_key', name='uq_scheduled_report_ledger_entries_key'),
    )
    op.create_index(
        'ix_scheduled_report_ledger_entries_subscription_date',
        'scheduled_report_ledger_entries',
        ['subscription_id', 'expected_date'],
    )
    op.create_index(
        'ix_scheduled_report_ledger_entries_status',
        'scheduled_report_ledger_entries',
        ['status'],
    )
    op.create_index(
        'ix_scheduled_report_ledger_entries_expected_at',
        'scheduled_report_ledger_entries',
        ['expected_at'],
    )


def downgrade() -> None:
    op.drop_index('ix_scheduled_report_ledger_entries_expected_at', table_name='scheduled_report_ledger_entries')
    op.drop_index('ix_scheduled_report_ledger_entries_status', table_name='scheduled_report_ledger_entries')
    op.drop_index('ix_scheduled_report_ledger_entries_subscription_date', table_name='scheduled_report_ledger_entries')
    op.drop_table('scheduled_report_ledger_entries')
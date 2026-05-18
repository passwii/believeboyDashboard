"""add alert tables

Revision ID: 20260517_122
Revises: 20260516_121
Create Date: 2026-05-17 00:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260517_122'
down_revision: Union[str, None] = '20260516_121'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'alert_rules',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('country', sa.String(length=2), nullable=False),
        sa.Column('metric', sa.String(length=32), nullable=False),
        sa.Column('condition', sa.String(length=16), nullable=False),
        sa.Column('threshold', sa.Float(), nullable=False),
        sa.Column('window_days', sa.Integer(), nullable=False),
        sa.Column('severity', sa.String(length=16), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_by', sa.String(length=128), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_ar_project_country', 'alert_rules', ['project_id', 'country'])
    op.create_index('idx_ar_metric_active', 'alert_rules', ['metric', 'is_active'])

    op.create_table(
        'alert_events',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('rule_id', sa.Integer(), nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('metric', sa.String(length=32), nullable=False),
        sa.Column('current_value', sa.Float(), nullable=False),
        sa.Column('baseline_value', sa.Float(), nullable=False),
        sa.Column('deviation_pct', sa.Float(), nullable=False),
        sa.Column('severity', sa.String(length=16), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('triggered_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('acknowledged_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('acknowledged_by', sa.String(length=128), nullable=True),
        sa.ForeignKeyConstraint(['rule_id'], ['alert_rules.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_ae_project_severity', 'alert_events', ['project_id', 'severity'])
    op.create_index('idx_ae_status_triggered', 'alert_events', ['status', 'triggered_at'])
    op.create_index('idx_ae_severity', 'alert_events', ['severity'])
    op.create_index('idx_ae_triggered_at', 'alert_events', ['triggered_at'])
    op.create_index('idx_ae_project_id', 'alert_events', ['project_id'])

    op.create_table(
        'alert_preferences',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False, index=True),
        sa.Column('email_enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('in_app_enabled', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('min_severity', sa.String(length=16), nullable=False, server_default='warning'),
        sa.Column('quiet_hours_start', sa.Time(), nullable=True),
        sa.Column('quiet_hours_end', sa.Time(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id'),
    )


def downgrade() -> None:
    op.drop_table('alert_preferences')
    op.drop_table('alert_events')
    op.drop_table('alert_rules')
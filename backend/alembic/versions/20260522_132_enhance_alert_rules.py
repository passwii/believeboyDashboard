"""enhance alert_rules with name trigger_type notification_channels

Revision ID: 132
Revises: 131
Create Date: 2026-05-22 08:05:00.000000

This migration adds the following columns to alert_rules:
- name: VARCHAR(64) NOT NULL - rule name
- trigger_type: VARCHAR(16) NOT NULL DEFAULT 'threshold' - threshold/baseline
- notification_channels: VARCHAR(16) NOT NULL DEFAULT 'in_app' - email/in_app/both
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '132'
down_revision: Union[str, None] = '131'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add new columns to alert_rules table
    # These columns use server_default so existing rows get a default value
    op.add_column(
        'alert_rules',
        sa.Column('name', sa.String(length=64), nullable=False, server_default='Alert Rule')
    )
    op.add_column(
        'alert_rules',
        sa.Column('trigger_type', sa.String(length=16), nullable=False, server_default='threshold')
    )
    op.add_column(
        'alert_rules',
        sa.Column('notification_channels', sa.String(length=16), nullable=False, server_default='in_app')
    )


def downgrade() -> None:
    op.drop_column('alert_rules', 'notification_channels')
    op.drop_column('alert_rules', 'trigger_type')
    op.drop_column('alert_rules', 'name')
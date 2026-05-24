"""add_stage_to_scheduled_report_delivery_logs

Revision ID: 143
Revises: 142
Create Date: 2026-05-24 19:50:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '143'
down_revision: Union[str, None] = '142'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column('stage', sa.String(length=20), nullable=False, server_default='pending',
                  comment='处理阶段: pending/preparing/building/sending/done/failed')
    )
    op.create_index(
        'ix_scheduled_report_delivery_logs_stage',
        'scheduled_report_delivery_logs',
        ['stage'],
        unique=False
    )


def downgrade() -> None:
    op.drop_index('ix_scheduled_report_delivery_logs_stage', table_name='scheduled_report_delivery_logs')
    op.drop_column('scheduled_report_delivery_logs', 'stage')
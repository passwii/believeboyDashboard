"""enhance alert_events with reconciliation fields

Revision ID: 134
Revises: 133
Create Date: 2026-05-22 13:00:00.000000

This migration adds the following columns to alert_events:
- match_rate: FLOAT - reconciliation match rate (0-100)
- mismatched_items: INTEGER - number of mismatched items
- total_diff: FLOAT - total amount difference
- report_month: VARCHAR(7) - report month for dedup (YYYY-MM)
- report_id: INTEGER - linked report ID for navigation
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "134"
down_revision: Union[str, None] = "133"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'alert_events',
        sa.Column('match_rate', sa.Float(), nullable=True)
    )
    op.add_column(
        'alert_events',
        sa.Column('mismatched_items', sa.Integer(), nullable=True)
    )
    op.add_column(
        'alert_events',
        sa.Column('total_diff', sa.Float(), nullable=True)
    )
    op.add_column(
        'alert_events',
        sa.Column('report_month', sa.String(length=7), nullable=True)
    )
    op.add_column(
        'alert_events',
        sa.Column('report_id', sa.Integer(), nullable=True)
    )
    # Add index for dedup query
    op.create_index(
        'idx_ae_recon_dedup',
        'alert_events',
        ['project_id', 'metric', 'report_month'],
        unique=False
    )


def downgrade() -> None:
    op.drop_index('idx_ae_recon_dedup', 'alert_events')
    op.drop_column('alert_events', 'report_id')
    op.drop_column('alert_events', 'report_month')
    op.drop_column('alert_events', 'total_diff')
    op.drop_column('alert_events', 'mismatched_items')
    op.drop_column('alert_events', 'match_rate')
"""add reconciliation_records table

Revision ID: reconciliation_records_v1
Revises: 20260508_117
Create Date: 2026-05-08 23:50:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'reconciliation_records_v1'
down_revision: Union[str, None] = '20260508_117'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create reconciliation_records table
    op.create_table(
        'reconciliation_records',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('report_id', sa.BigInteger(), nullable=False),
        sa.Column('operator', sa.String(length=255), nullable=False),
        sa.Column('mode', sa.String(length=20), nullable=False),
        sa.Column('match_rate', sa.Numeric(precision=5, scale=2), server_default='0', nullable=False),
        sa.Column('matched_items', sa.Integer(), server_default='0', nullable=False),
        sa.Column('mismatched_items', sa.Integer(), server_default='0', nullable=False),
        sa.Column('missing_items', sa.Integer(), server_default='0', nullable=False),
        sa.Column('detail_json', sa.JSON(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['report_id'], ['monthly_reports.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('report_id', 'mode', name='reconciliation_records_report_mode_key'),
    )

    # Create indexes
    op.create_index('idx_reconciliation_report', 'reconciliation_records', ['report_id'])
    op.create_index('idx_reconciliation_created', 'reconciliation_records', ['created_at'])


def downgrade() -> None:
    op.drop_index('idx_reconciliation_created', table_name='reconciliation_records')
    op.drop_index('idx_reconciliation_report', table_name='reconciliation_records')
    op.drop_table('reconciliation_records')

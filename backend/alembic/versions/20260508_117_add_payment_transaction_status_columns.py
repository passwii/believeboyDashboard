"""Add transaction status and release date to analysis_payment_rows

Revision ID: 20260508_117
Revises: 20260505_116
Create Date: 2026-05-08 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260508_117'
down_revision: Union[str, None] = '20260505_116'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 添加 transaction_status 列
    op.add_column(
        'analysis_payment_rows',
        sa.Column('transaction_status', sa.String(length=32), nullable=True)
    )
    # 添加 transaction_release_date 列
    op.add_column(
        'analysis_payment_rows',
        sa.Column('transaction_release_date', sa.DateTime(timezone=True), nullable=True)
    )
    # 创建索引
    op.execute('create index if not exists idx_analysis_payment_status on analysis_payment_rows (transaction_status)')
    op.execute('create index if not exists idx_analysis_payment_release_date on analysis_payment_rows (transaction_release_date)')


def downgrade() -> None:
    op.execute('drop index if exists idx_analysis_payment_release_date')
    op.execute('drop index if exists idx_analysis_payment_status')
    op.drop_column('analysis_payment_rows', 'transaction_release_date')
    op.drop_column('analysis_payment_rows', 'transaction_status')
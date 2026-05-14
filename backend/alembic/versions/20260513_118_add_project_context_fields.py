"""Add project_context and sku_context fields

Revision ID: 20260513_118
Revises: 20260508_117
Create Date: 2026-05-13 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260513_118'
down_revision: Union[str, Sequence[str], None] = 'reconciliation_records_v1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'projects',
        sa.Column('project_context', sa.JSON(), nullable=False, server_default='{}'),
    )
    op.add_column(
        'projects',
        sa.Column('sku_context', sa.JSON(), nullable=False, server_default='{}'),
    )


def downgrade() -> None:
    op.drop_column('projects', 'sku_context')
    op.drop_column('projects', 'project_context')
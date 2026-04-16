"""Add return_analysis tables

Revision ID: 20260410_088
Revises: 20260410_086
Create Date: 2026-04-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '20260410_088'
down_revision: Union[str, None] = '20260410_087'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Create return_analysis_records table
    op.create_table(
        'return_analysis_records',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('project_id', sa.Integer(), nullable=False),
        sa.Column('country', sa.String(length=10), server_default='US', nullable=False),
        sa.Column('return_date', sa.String(length=20), nullable=False),
        sa.Column('order_id', sa.String(length=50), nullable=False),
        sa.Column('sku', sa.String(length=100), nullable=False),
        sa.Column('asin', sa.String(length=20), nullable=True),
        sa.Column('fnsku', sa.String(length=20), nullable=True),
        sa.Column('product_name', sa.Text(), nullable=True),
        sa.Column('quantity', sa.Integer(), nullable=False, server_default='1'),
        sa.Column('fulfillment_center_id', sa.String(length=20), nullable=True),
        sa.Column('detailed_disposition', sa.String(length=50), nullable=False),
        sa.Column('reason', sa.String(length=100), nullable=False),
        sa.Column('status', sa.String(length=100), nullable=False),
        sa.Column('license_plate_number', sa.String(length=30), nullable=True),
        sa.Column('original_return_datetime', sa.String(length=30), nullable=False),
        sa.Column('is_current', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'project_id', 'country', 'order_id', 'sku', 'original_return_datetime',
            'license_plate_number',
            name='uq_return_record_key'
        ),
    )
    op.create_index('idx_return_analysis_project_id', 'return_analysis_records', ['project_id'])
    op.create_index('idx_return_analysis_return_date', 'return_analysis_records', ['return_date'])
    op.create_index('idx_return_analysis_sku', 'return_analysis_records', ['sku'])
    op.create_index('idx_return_analysis_project_date', 'return_analysis_records', ['project_id', 'return_date'])

    # Create return_customer_comments table
    op.create_table(
        'return_customer_comments',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('return_record_id', sa.Integer(), nullable=False),
        sa.Column('sku', sa.String(length=100), nullable=False),
        sa.Column('order_id', sa.String(length=50), nullable=False),
        sa.Column('customer_comment', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['return_record_id'], ['return_analysis_records.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_customer_comments_sku_order', 'return_customer_comments', ['sku', 'order_id'])


def downgrade() -> None:
    op.drop_index('idx_customer_comments_sku_order', 'return_customer_comments')
    op.drop_table('return_customer_comments')
    op.drop_index('idx_return_analysis_project_date', 'return_analysis_records')
    op.drop_index('idx_return_analysis_sku', 'return_analysis_records')
    op.drop_index('idx_return_analysis_return_date', 'return_analysis_records')
    op.drop_index('idx_return_analysis_project_id', 'return_analysis_records')
    op.drop_table('return_analysis_records')

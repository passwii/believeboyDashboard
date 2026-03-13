"""drop first_leg_unit_cost from product_costs

Revision ID: 20260313_042
Revises: 20260313_041
Create Date: 2026-03-13 20:10:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = '20260313_042'
down_revision = '20260313_041'
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table('product_costs') as batch_op:
        batch_op.drop_column('first_leg_unit_cost')


def downgrade() -> None:
    with op.batch_alter_table('product_costs') as batch_op:
        batch_op.add_column(sa.Column('first_leg_unit_cost', sa.Numeric(12, 2), nullable=False, server_default='0'))

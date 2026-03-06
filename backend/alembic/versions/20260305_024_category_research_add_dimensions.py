"""add dimensions fields to category research product details

Revision ID: 20260305_024
Revises: 20260305_023
Create Date: 2026-03-05 16:30:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260305_024'
down_revision: Union[str, None] = '20260305_023'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(col['name'] == column_name for col in inspector.get_columns(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    table_name = 'category_research_product_details'
    if _has_table(inspector, table_name) is False:
        return

    if _has_column(inspector, table_name, 'extracted_dimensions') is False:
        op.add_column(
            table_name,
            sa.Column('extracted_dimensions', sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        )

    inspector = sa.inspect(bind)
    if _has_column(inspector, table_name, 'manual_dimensions') is False:
        op.add_column(
            table_name,
            sa.Column('manual_dimensions', sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    table_name = 'category_research_product_details'
    if _has_table(inspector, table_name) is False:
        return

    if _has_column(inspector, table_name, 'manual_dimensions'):
        op.drop_column(table_name, 'manual_dimensions')

    inspector = sa.inspect(bind)
    if _has_column(inspector, table_name, 'extracted_dimensions'):
        op.drop_column(table_name, 'extracted_dimensions')

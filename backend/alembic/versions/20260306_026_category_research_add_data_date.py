"""category research add data date

Revision ID: 20260306_026
Revises: 20260306_025
Create Date: 2026-03-06 11:45:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '20260306_026'
down_revision: Union[str, None] = '20260306_025'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(inspector: sa.Inspector, table_name: str) -> bool:
    return table_name in inspector.get_table_names()


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return any(column.get('name') == column_name for column in inspector.get_columns(table_name))


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return any(idx.get('name') == index_name for idx in inspector.get_indexes(table_name))


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'category_research_datasets') is False:
        return

    if _has_column(inspector, 'category_research_datasets', 'data_date') is False:
        op.add_column(
            'category_research_datasets',
            sa.Column('data_date', sa.Date(), nullable=True, server_default=sa.text('CURRENT_DATE')),
        )

        op.execute(
            sa.text(
                """
                UPDATE category_research_datasets
                SET data_date = DATE(created_at)
                WHERE data_date IS NULL AND created_at IS NOT NULL
                """
            )
        )
        op.execute(
            sa.text(
                """
                UPDATE category_research_datasets
                SET data_date = CURRENT_DATE
                WHERE data_date IS NULL
                """
            )
        )

    inspector = sa.inspect(bind)
    if _has_index(inspector, 'category_research_datasets', 'idx_category_research_data_date') is False:
        op.create_index('idx_category_research_data_date', 'category_research_datasets', ['data_date'], unique=False)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, 'category_research_datasets') is False:
        return

    if _has_index(inspector, 'category_research_datasets', 'idx_category_research_data_date'):
        op.drop_index('idx_category_research_data_date', table_name='category_research_datasets')

    inspector = sa.inspect(bind)
    if _has_column(inspector, 'category_research_datasets', 'data_date'):
        op.drop_column('category_research_datasets', 'data_date')

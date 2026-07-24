"""crm 客户/线索增加 next_follow_at（待跟进视图 P2b）

Revision ID: 219
Revises: 218
Create Date: 2026-07-24 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "219"
down_revision: Union[str, None] = "218"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (表, 列名) — 新增 nullable DateTime(tz) 列
_NEW_COLUMNS = [
    ("crm_customers", "next_follow_at"),
    ("crm_leads", "next_follow_at"),
]

# (索引名, 表, 列名)
_NEW_INDEXES = [
    ("idx_cc_next_follow", "crm_customers", "next_follow_at"),
    ("idx_cl_next_follow", "crm_leads", "next_follow_at"),
]


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column["name"] for column in inspector.get_columns(table_name)}


def _has_index(inspector: sa.Inspector, table_name: str, index_name: str) -> bool:
    return index_name in {idx["name"] for idx in inspector.get_indexes(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, column in _NEW_COLUMNS:
        if inspector.has_table(table) and not _has_column(inspector, table, column):
            op.add_column(table, sa.Column(column, sa.DateTime(timezone=True), nullable=True))
    for index_name, table, column in _NEW_INDEXES:
        if inspector.has_table(table) and not _has_index(inspector, table, index_name):
            op.create_index(index_name, table, [column])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for index_name, table, _column in _NEW_INDEXES:
        if inspector.has_table(table) and _has_index(inspector, table, index_name):
            op.drop_index(index_name, table_name=table)
    for table, column in _NEW_COLUMNS:
        if inspector.has_table(table) and _has_column(inspector, table, column):
            op.drop_column(table, column)

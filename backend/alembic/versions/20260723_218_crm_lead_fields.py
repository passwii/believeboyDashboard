"""crm 线索/客户加对象类型+意向服务, 联系人加微信

Revision ID: 218
Revises: 217
Create Date: 2026-07-23 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "218"
down_revision: Union[str, None] = "217"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# (表, 列名, 类型) — 新增 nullable 列
_NEW_COLUMNS = [
    ("crm_leads", "customer_type", sa.String(20)),
    ("crm_leads", "interested_service", sa.String(30)),
    ("crm_customers", "customer_type", sa.String(20)),
    ("crm_customers", "interested_service", sa.String(30)),
    ("crm_contacts", "wechat", sa.String(100)),
]


def _has_column(inspector: sa.Inspector, table_name: str, column_name: str) -> bool:
    return column_name in {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, column, type_ in _NEW_COLUMNS:
        if inspector.has_table(table) and not _has_column(inspector, table, column):
            op.add_column(table, sa.Column(column, type_, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table, column, _type in _NEW_COLUMNS:
        if inspector.has_table(table) and _has_column(inspector, table, column):
            op.drop_column(table, column)

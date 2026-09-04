"""analysis_sales_order_rows 增加 purchase_at_pt 索引（order-info 列表默认排序列）

order-info 页面列表默认按 purchase_at_pt DESC 分页，但该列此前无索引，
每次翻页/筛选都要对命中行做全量排序；大表 + 频繁筛选下是页面卡顿、
后端 CPU/内存飙升的主因之一。补一个 B-tree 索引（PG 可反向扫描支持 DESC）。

Revision ID: 221
Revises: 220
Create Date: 2026-07-28 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "221"
down_revision: Union[str, None] = "220"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "analysis_sales_order_rows"
_INDEX_NAME = "idx_analysis_sales_order_purchase_at_pt"
_INDEX_COLUMNS = ["purchase_at_pt"]


def _has_index(inspector: sa.Inspector, index_name: str) -> bool:
    return index_name in {idx["name"] for idx in inspector.get_indexes(_TABLE)}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_index(inspector, _INDEX_NAME):
        op.create_index(_INDEX_NAME, _TABLE, _INDEX_COLUMNS)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_index(inspector, _INDEX_NAME):
        op.drop_index(_INDEX_NAME, table_name=_TABLE)

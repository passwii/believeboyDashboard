"""analysis_sales_order_rows 增加 (project_id, purchase_at_pt) 复合索引

order-info 列表默认「自动选中首个店铺 + 按 purchase_at_pt DESC 分页」。项目过滤
打在行级冗余列 project_id 后（见 apply_sql_filters），该复合索引让单项目分页直接
索引直扫（Index Scan Backward, project_id=N 按 purchase_at_pt 倒序），不必跨项目
全表倒扫再逐行过滤——prod 实测单项目默认视图从 ~119ms 降到 ~5ms。

保留迁移 221 的 purchase_at_pt 单列索引：服务「全部店铺」（无项目过滤）的全局
排序分页，复合索引前导列是 project_id，对无项目过滤的查询不适用。

Revision ID: 222
Revises: 221
Create Date: 2026-07-28 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "222"
down_revision: Union[str, None] = "221"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "analysis_sales_order_rows"
_INDEX_NAME = "idx_analysis_sales_order_project_purchase_at_pt"
_INDEX_COLUMNS = ["project_id", "purchase_at_pt"]


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

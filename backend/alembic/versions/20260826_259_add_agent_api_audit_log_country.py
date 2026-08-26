"""agent_api_audit_log 加 country 列（BLF-845 项目日志国家维度）。

Revision ID: 259
Revises: 258
Create Date: 2026-08-26 19:40:53.493955

中间件从 query string 解析 ``country`` 参数（大写归一、截断 8 字符）
写入；历史行与无 country 请求为 NULL，前端显示 '—'。高流量审计表
（90 天保留）仅展示不筛选，故不加索引。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "259"
down_revision: Union[str, None] = "258"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_api_audit_log",
        sa.Column("country", sa.String(length=8), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_api_audit_log", "country")

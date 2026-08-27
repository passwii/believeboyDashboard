"""agent_api_keys 加管理 Key 全局单例部分唯一索引（BLF-847 红线 B）。

Revision ID: 260
Revises: 259
Create Date: 2026-08-27 09:40:00.000000

并发兜底：管理 Key 全系统同一时刻只允许存在「一张有效」且持有签发域
(agent_provisioning) 的凭据。应用层已在 internal/api_keys 的 create / PATCH
做单例互斥校验（active_provisioning_key_exists），但极端双发仍可能同时落库——
本迁移用 Postgres 部分唯一索引在数据库层彻底封死。

部分谓词 = 有效（未删除、未停用、未过期）且 business_scope 含 agent_provisioning。
Admin Key 按 Yawei 拍板为永久（expires_at IS NULL），故用 expires_at IS NULL
精确刻画「有效」。索引列是常量表达式 (1)，使所有命中谓词的行在索引中必然冲突，
从而保证至多一行。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "260"
down_revision: Union[str, Sequence[str], None] = "259"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_INDEX_NAME = "uq_aak_active_provisioning"

# 部分谓词：有效 且 持有签发域。LIKE 精确匹配域 code（现有 12 域 + agent_provisioning
# 无互相包含关系，不会误命中）；Admin Key 永久 → expires_at IS NULL 即有效。
_WHERE = sa.text(
    "is_revoked = false "
    "AND deleted_at IS NULL "
    "AND expires_at IS NULL "
    "AND business_scope LIKE '%agent_provisioning%'"
)


def upgrade() -> None:
    op.create_index(
        _INDEX_NAME,
        "agent_api_keys",
        # 常量表达式列：所有命中谓词的行索引值均为 1 → 唯一约束保证至多一行。
        [sa.text("(1)")],
        unique=True,
        postgresql_where=_WHERE,
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="agent_api_keys")

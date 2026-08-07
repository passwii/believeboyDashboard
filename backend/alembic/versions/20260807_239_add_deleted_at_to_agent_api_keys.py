"""add deleted_at to agent_api_keys (BLF-468)

Soft-delete tombstone：保留审计轨迹（``operation_audit_logs.target_id`` 引用
Key 行 id）；鉴权路径 ``resolve_key`` / ``resolve_key_for_agent`` 必须把
``deleted_at IS NOT NULL`` 视为 ``not_found``，且判定**先于** ``revoked``，
防止删除后被误激活的 Key 复活认证。

默认列表隐藏已删除行（去噪音），通过 ``?include_deleted=true`` 审计/回溯。
小表无需新索引——查询走现有 ``idx_aak_revoked_expires``。

Revision ID: 239
Revises: 238
Create Date: 2026-08-07
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "239"
down_revision: Union[str, None] = "238"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent_api_keys",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_api_keys", "deleted_at")

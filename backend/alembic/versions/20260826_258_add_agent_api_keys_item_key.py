"""agent_api_keys 加 item_key 外部身份引用列 (BLF-843)

Revision ID: 258
Revises: 257
Create Date: 2026-08-26

BLF-843：给每张 agent 凭据标注「签发对象在外部 agent 平台的身份引用」
（如 ``multica://<workspace-id>/agent/<agent-id>``，或 operator-manager 标识），
把这张凭据 ↔ 外部 provider 身份对应起来。纯加列、可空、默认 NULL，
无存量风险；创建可选传入、列表随行返回、PATCH 可修改。
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "258"
down_revision: str | None = "257"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "agent_api_keys",
        sa.Column("item_key", sa.String(length=128), nullable=True),
    )
    op.create_index("idx_aak_item_key", "agent_api_keys", ["item_key"])


def downgrade() -> None:
    op.drop_index("idx_aak_item_key", table_name="agent_api_keys")
    op.drop_column("agent_api_keys", "item_key")

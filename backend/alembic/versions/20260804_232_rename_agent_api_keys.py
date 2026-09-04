"""rename external_api_keys to agent_api_keys and add agent columns

Revision ID: 232
Revises: 231
Create Date: 2026-08-04

Agent API 设计稿 §11：凭据表改名 external_api_keys → agent_api_keys，
并加 agent 绑定列。RENAME 是 PG 目录级操作（毫秒级、不重写数据），
与加列同一迁移保证原子。索引改名仅 PG 需要（SQLite 保留旧名无影响）。

- agent_id：绑定的 Agent 稳定标识；存量 external key 为 NULL（行为不变）
- project_scope：预留授权范围，P0 不强制校验（设计稿 §9 #2）
"""

import sqlalchemy as sa
from alembic import op

revision = "232"
down_revision = "231"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.rename_table("external_api_keys", "agent_api_keys")
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER INDEX idx_eak_key_hash RENAME TO idx_aak_key_hash")
        op.execute("ALTER INDEX idx_eak_revoked_expires RENAME TO idx_aak_revoked_expires")
    op.add_column(
        "agent_api_keys", sa.Column("agent_id", sa.String(length=128), nullable=True)
    )
    op.add_column(
        "agent_api_keys",
        sa.Column(
            "project_scope",
            sa.String(length=255),
            nullable=False,
            server_default="*",
        ),
    )
    op.create_index("idx_aak_agent_id", "agent_api_keys", ["agent_id"])


def downgrade() -> None:
    op.drop_index("idx_aak_agent_id", table_name="agent_api_keys")
    op.drop_column("agent_api_keys", "project_scope")
    op.drop_column("agent_api_keys", "agent_id")
    if op.get_bind().dialect.name == "postgresql":
        op.execute("ALTER INDEX idx_aak_key_hash RENAME TO idx_eak_key_hash")
        op.execute(
            "ALTER INDEX idx_aak_revoked_expires RENAME TO idx_eak_revoked_expires"
        )
    op.rename_table("agent_api_keys", "external_api_keys")

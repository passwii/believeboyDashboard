"""用户专属 API Key 表 user_api_keys (BLF-711 C2 方案)

Revision ID: 257
Revises: 256
Create Date: 2026-08-15 20:00:00

BLF-711：桌面端 GUI 直连后端需要按账号下发的专属 key（只存 SHA-256 hash，
不存明文）。每个用户至多一行（user_id unique）；吊销用 revoked_at 时间戳
标记；登录轮换 / 管理员吊销 / 轮换走现有 operation_audit_logs 审计。
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID


# revision identifiers, used by Alembic.
revision: str = "257"
down_revision: str | None = "256"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "user_api_keys",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("user_accounts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key_hash", sa.String(64), nullable=False),
        sa.Column("key_prefix", sa.String(24), nullable=False),
        sa.Column("revoked_at", TIMESTAMP(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Index("idx_uak_key_hash", "key_hash", unique=True),
        sa.Index("idx_uak_user_id", "user_id", unique=True),
    )


def downgrade() -> None:
    op.drop_table("user_api_keys")

"""add external api keys and audit log

Revision ID: 227
Revises: 226
Create Date: 2026-08-02

BEL-377 P1 external API infrastructure：
- external_api_keys：/api/v1/external/* 的应用层凭证（只存 SHA-256 hash）
- external_api_audit_log：每个 external 请求一行（method/path/key/status/latency/ip）

设计要点：
- 主键 id INTEGER（与 alert_rule.py 屋风一致）
- key_hash 唯一索引 —— 鉴权路径按 hash 查
- audit 表 created_at 索引 —— 90 天保留清理走范围删除
- audit.api_key_id 故意不做 FK：key 删除后审计行必须留存
"""

from alembic import op
import sqlalchemy as sa

revision = "227"
down_revision = "226"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "external_api_keys",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column(
            "key_hash",
            sa.String(length=64),
            nullable=False,
            comment="SHA-256 hex digest of the plaintext key",
        ),
        sa.Column(
            "key_prefix",
            sa.String(length=24),
            nullable=False,
            comment="Non-secret prefix for admin display",
        ),
        sa.Column("label", sa.String(length=128), nullable=False),
        sa.Column(
            "scope",
            sa.String(length=64),
            nullable=False,
            server_default="read",
            comment="Reserved for P2 per-key scope restrictions",
        ),
        sa.Column(
            "is_revoked",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(length=128), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_eak_key_hash", "external_api_keys", ["key_hash"], unique=True)
    op.create_index(
        "idx_eak_revoked_expires",
        "external_api_keys",
        ["is_revoked", "expires_at"],
    )

    op.create_table(
        "external_api_audit_log",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.Column("path", sa.String(length=255), nullable=False),
        sa.Column("api_key_id", sa.Integer(), nullable=True),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column(
            "latency_ms",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("ip_address", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_eaal_created_at", "external_api_audit_log", ["created_at"])
    op.create_index("idx_eaal_api_key_id", "external_api_audit_log", ["api_key_id"])


def downgrade() -> None:
    op.drop_index("idx_eaal_api_key_id", table_name="external_api_audit_log")
    op.drop_index("idx_eaal_created_at", table_name="external_api_audit_log")
    op.drop_table("external_api_audit_log")
    op.drop_index("idx_eak_revoked_expires", table_name="external_api_keys")
    op.drop_index("idx_eak_key_hash", table_name="external_api_keys")
    op.drop_table("external_api_keys")

"""下架后端 PG backup 方案，drop backup_records (BLF-656)

Revision ID: 256
Revises: 255
Create Date: 2026-08-12 15:10:00

BLF-656：后端 pgBackRest → R2 备份方案从未上线运行、从未向 R2 写入数据，
用户拍板整体下架（含 Celery beat 调度 / API 端点 / 前端页面 / 测试），
backup_records 表一并删除。downgrade 按 135 + 214 + 231 三段迁移的最终
schema 重建空表（数据不可恢复，冷备兜底见 autopilot「运营数据库备份」）。
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import BIGINT, TIMESTAMP


# revision identifiers, used by Alembic.
revision: str = "256"
down_revision: str | None = "255"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    # BLF-656：整表删除（索引随表一并删除）
    op.drop_table("backup_records")


def downgrade() -> None:
    # 按 135 + 20260718_214 + 231 的最终 schema 重建空表（数据不可恢复）
    op.create_table(
        "backup_records",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("backup_type", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), nullable=False),
        sa.Column("started_at", TIMESTAMP(timezone=True), nullable=False),
        sa.Column("completed_at", TIMESTAMP(timezone=True), nullable=True),
        sa.Column("size_bytes", BIGINT(), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("backup_info", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("phase", sa.String(20), nullable=False, server_default="pending"),
        sa.Column(
            "triggered_by", sa.String(20), nullable=False, server_default="manual"
        ),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("backup_set_name", sa.String(100), nullable=True),
        sa.Column("r2_key", sa.String(500), nullable=True),
        sa.Column("r2_url", sa.String(1000), nullable=True),
        sa.Column("r2_bucket", sa.String(200), nullable=True),
        sa.Column("r2_uploaded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("r2_deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("compressed_size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("backup_set_path", sa.String(500), nullable=True),
        sa.Index("idx_br_status", "status"),
        sa.Index("idx_br_created", "created_at"),
        sa.Index("idx_br_type", "backup_type"),
        sa.Index("idx_br_phase", "phase"),
        sa.Index(
            "idx_br_r2_key",
            "r2_key",
            postgresql_where=sa.text("r2_key IS NOT NULL"),
        ),
    )

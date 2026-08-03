"""Add R2 + audit fields to backup_records.

Revision ID: 231
Revises: 230
Create Date: 2026-07-22 10:00:00

Plan: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/2026-07-17-pg-r2-backup-feature-continuation.md §3.4 P0-4
补主 plan §3.4 剩余 7 字段（前 4 个已由 20260718_214 落地）。纯加列 + 1 部分索引，downgrade 可回滚。

注：本迁移原编号 20260722_215（down_revision=20260718_214），与 main 上已合入的
215（add_crm_tables）撞号；分支合入前按 AGENTS.md 防撞流程重排为 231，挂到当前链尾（230 之后）。
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision: str = "231"
down_revision: str | None = "230"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column("backup_records", sa.Column("r2_key", sa.String(500), nullable=True))
    op.add_column("backup_records", sa.Column("r2_url", sa.String(1000), nullable=True))
    op.add_column(
        "backup_records", sa.Column("r2_bucket", sa.String(200), nullable=True)
    )
    op.add_column(
        "backup_records",
        sa.Column("r2_uploaded_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "backup_records",
        sa.Column("r2_deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "backup_records",
        sa.Column("compressed_size_bytes", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "backup_records", sa.Column("backup_set_path", sa.String(500), nullable=True)
    )
    op.create_index(
        "idx_br_r2_key",
        "backup_records",
        ["r2_key"],
        postgresql_where=sa.text("r2_key IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_br_r2_key", table_name="backup_records")
    op.drop_column("backup_records", "backup_set_path")
    op.drop_column("backup_records", "compressed_size_bytes")
    op.drop_column("backup_records", "r2_deleted_at")
    op.drop_column("backup_records", "r2_uploaded_at")
    op.drop_column("backup_records", "r2_bucket")
    op.drop_column("backup_records", "r2_url")
    op.drop_column("backup_records", "r2_key")

"""Add phase / triggered_by / retry_count / backup_set_name to backup_records.

Revision ID: 20260718_214
Revises: b2c3d4e5f6a7
Create Date: 2026-07-18 11:30:00

Plan: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/ §3.4 P0-4
- phase:            状态机 pending → pgbackrest_running → completed / failed
- triggered_by:     manual / auto, 区分自动定时 vs 手动触发
- retry_count:      worker 重投次数 (幂等护栏辅助)
- backup_set_name:  pgbackrest set label (如 20260717-030000F), 供 restore 拼命令

纯加列 + 1 索引, 回滚用 downgrade 即可。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "20260718_214"
down_revision: str | None = "b2c3d4e5f6a7"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.add_column(
        "backup_records",
        sa.Column("phase", sa.String(20), nullable=False, server_default="pending"),
    )
    op.add_column(
        "backup_records",
        sa.Column("triggered_by", sa.String(20), nullable=False, server_default="manual"),
    )
    op.add_column(
        "backup_records",
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column(
        "backup_records",
        sa.Column("backup_set_name", sa.String(100), nullable=True),
    )
    op.create_index("idx_br_phase", "backup_records", ["phase"])


def downgrade() -> None:
    op.drop_index("idx_br_phase", table_name="backup_records")
    op.drop_column("backup_records", "backup_set_name")
    op.drop_column("backup_records", "retry_count")
    op.drop_column("backup_records", "triggered_by")
    op.drop_column("backup_records", "phase")

"""add file_sha256 to ad_upload_files (PR #2 dedup)

ad_upload_files (C 表) 需要 file_sha256 列支持 autoReportUpload 的 SHA-256 dedup。
原先 dedup 只查 analysis_source_files (A 表), 但 ad 报表已切到 C 表后, 重复的 ad 报表
会被反复入库。

升级:
1. ADD COLUMN file_sha256 VARCHAR(64) (nullable, 历史行无 hash)
2. CREATE INDEX idx_ad_upload_files_file_sha256 (用于 dedup 查询)

降级:
1. DROP INDEX
2. DROP COLUMN

Revision ID: 154
Revises: 153
Create Date: 2026-06-02
"""
import sqlalchemy as sa
from alembic import op


revision = "154"
down_revision = "153"
branch_labels = None
depends_on = None


_TABLE = "ad_upload_files"
_INDEX = "idx_ad_upload_files_file_sha256"
_COLUMN = "file_sha256"


def upgrade() -> None:
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sa.String(length=64), nullable=True),
    )
    op.create_index(_INDEX, _TABLE, [_COLUMN], unique=False)


def downgrade() -> None:
    op.drop_index(_INDEX, table_name=_TABLE)
    op.drop_column(_TABLE, _COLUMN)

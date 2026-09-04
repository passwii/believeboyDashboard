"""fix ad_upload_files ingestion_status 'saved' -> 'success'

autoReportUpload 通过 save_ad_upload_scope() 写入的 AdUploadFile 记录
ingestion_status 为 'saved'（默认值）。但 RPA 状态查询 Priority 3 需要
ingestion_status == 'success' 才能匹配，导致通过 autoReportUpload 上传的
ad_budget_report 等广告报表在前端 RPA 状态网格中始终显示红色（未上传）。

此迁移将所有 ingestion_status='saved' 的 ad_upload_files 行更新为 'success'。

代码侧也做了同步修复：autoReportUpload/processor.py 在 db.commit() 前将
ingestion_status 从 'saved' 更新为 'success'。

Revision ID: 155
Revises: 154
Create Date: 2026-06-02
"""
from alembic import op


revision = "155"
down_revision = "154"
branch_labels = None
depends_on = None

_TABLE = "ad_upload_files"


_CONSTRAINT_NAME = "ck_ad_upload_files_ingestion_status"


def upgrade() -> None:
    op.execute(
        f"""
        ALTER TABLE {_TABLE}
        DROP CONSTRAINT {_CONSTRAINT_NAME}
        """
    )
    op.execute(
        f"""
        ALTER TABLE {_TABLE}
        ADD CONSTRAINT {_CONSTRAINT_NAME}
        CHECK (ingestion_status IN ('pending', 'saved', 'failed', 'success'))
        """
    )
    op.execute(
        f"""
        UPDATE {_TABLE}
        SET ingestion_status = 'success'
        WHERE ingestion_status = 'saved'
        """
    )


def downgrade() -> None:
    op.execute(
        f"""
        UPDATE {_TABLE}
        SET ingestion_status = 'saved'
        WHERE ingestion_status = 'success'
          AND created_by = 'autoReportUpload'
        """
    )
    op.execute(
        f"""
        ALTER TABLE {_TABLE}
        DROP CONSTRAINT {_CONSTRAINT_NAME}
        """
    )
    op.execute(
        f"""
        ALTER TABLE {_TABLE}
        ADD CONSTRAINT {_CONSTRAINT_NAME}
        CHECK (ingestion_status IN ('pending', 'saved', 'failed'))
        """
    )
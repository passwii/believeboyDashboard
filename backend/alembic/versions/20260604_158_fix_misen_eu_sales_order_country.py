"""修正经森项目销售订单行的国家标记

analysis_sales_order_rows 中有 344 行数据：
源文件 country=DE 但行 country=US（上传时选错了国家）。
此迁移根据源文件的国家字段修正行级 country。

Revision ID: 158
Revises: 157
Create Date: 2026-06-04
"""

from alembic import op
import sqlalchemy as sa

revision = "158"
down_revision = "157"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        UPDATE analysis_sales_order_rows AS aso
        SET country = asf.country
        FROM analysis_source_files AS asf
        WHERE aso.source_file_id = asf.id
          AND asf.project_id = 10
          AND aso.country != asf.country
          AND asf.country IN ('DE', 'UK')
    """)


def downgrade() -> None:
    op.execute("""
        UPDATE analysis_sales_order_rows AS aso
        SET country = 'US'
        FROM analysis_source_files AS asf
        WHERE aso.source_file_id = asf.id
          AND asf.project_id = 10
          AND aso.country IN ('DE', 'UK')
          AND asf.country IN ('DE', 'UK')
          AND EXISTS (
              SELECT 1 FROM analysis_sales_order_rows AS old
              WHERE old.id = aso.id
                AND old.country = 'US'
          )
    """)
"""sales rows: 行级唯一键 + 冗余 project_id（BEL-348）

- 新增 project_id 列（冗余，便于直接按行计数，不再依赖 source_file 版本选择），
  并从 analysis_source_files 回填。
- 新增 data_version 列（行级数据版本，upsert 时自增，仅审计用）。
- 历史去重：同一 (project_id, amazon_order_id, sku, country, purchase_date_pt) 在多代版本里重复出现，
  保留 id 最大（最新状态）的一行，删除其余。注意：只出现在某一版本、未跨版本重复的
  订单行（如 2026-07-15 的 12 行仅存于 v2）各自成组、不会被删，从而修复"整文件版本
  选择把更全旧版本覆盖掉"导致丢单的问题。
  关键：唯一键含 purchase_date_pt，因此同一订单落在相邻日期桶（如 06-23 与 06-24 各一行）
  视为不同组、互不删除——避免误删跨桶同订单的真实分布。
- 删除旧唯一约束 analysis_sales_order_rows_source_row_key，
  新建行级唯一约束 uq_sales_order_project_order_sku_country（含 purchase_date_pt）。
- 新增索引 idx_analysis_sales_order_project / _project_country_date。

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-07-17
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = 'b2c3d4e5f6a7'
down_revision = 'a1b2c3d4e5f6'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1) 新增 project_id（先 nullable，回填后再 NOT NULL）
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column(
            'project_id',
            sa.BigInteger().with_variant(sa.Integer, 'sqlite'),
            sa.ForeignKey('projects.id', ondelete='CASCADE'),
            nullable=True,
        ),
    )
    # 2) 新增 data_version
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('data_version', sa.Integer(), nullable=False, server_default=sa.text('1')),
    )
    # 3) 回填 project_id（来自所属 source_file）
    op.execute(
        """
        UPDATE analysis_sales_order_rows r
        SET project_id = f.project_id
        FROM analysis_source_files f
        WHERE r.source_file_id = f.id
          AND r.project_id IS NULL
        """
    )
    op.execute("ALTER TABLE analysis_sales_order_rows ALTER COLUMN project_id SET NOT NULL")

    # 4) 历史去重：同一 (project_id, amazon_order_id, sku, country, purchase_date_pt)
    #    多版本重复，保留 id 最大（最新状态）的一行。
    #    注意：必须按 purchase_date_pt 分组，否则同一订单落在相邻日期桶
    #    （如 06-23 与 06-24 各一行）会被误判为冲突而删掉其一，制造新丢单。
    #    COALESCE(sku,'') / COALESCE(purchase_date_pt, '1970-01-01') 让 NULL 也参与分组。
    op.execute(
        """
        DELETE FROM analysis_sales_order_rows a
        USING analysis_sales_order_rows b
        WHERE a.id < b.id
          AND a.project_id = b.project_id
          AND a.amazon_order_id = b.amazon_order_id
          AND COALESCE(a.sku, '') = COALESCE(b.sku, '')
          AND a.country = b.country
          AND COALESCE(a.purchase_date_pt, '1970-01-01'::date) = COALESCE(b.purchase_date_pt, '1970-01-01'::date)
        """
    )

    # 5) 替换唯一约束（含 purchase_date_pt，避免跨桶同订单被误合并）
    op.drop_constraint(
        'analysis_sales_order_rows_source_row_key',
        'analysis_sales_order_rows',
        type_='unique',
    )
    op.create_unique_constraint(
        'uq_sales_order_project_order_sku_country',
        'analysis_sales_order_rows',
        ['project_id', 'amazon_order_id', 'sku', 'country', 'purchase_date_pt'],
    )

    # 6) 索引
    op.create_index('idx_analysis_sales_order_project', 'analysis_sales_order_rows', ['project_id'])
    op.create_index(
        'idx_analysis_sales_order_project_country_date',
        'analysis_sales_order_rows',
        ['project_id', 'country', 'purchase_date_pt'],
    )


def downgrade() -> None:
    op.drop_index('idx_analysis_sales_order_project_country_date', table_name='analysis_sales_order_rows')
    op.drop_index('idx_analysis_sales_order_project', table_name='analysis_sales_order_rows')
    op.drop_constraint(
        'uq_sales_order_project_order_sku_country',
        'analysis_sales_order_rows',
        type_='unique',
    )
    op.create_unique_constraint(
        'analysis_sales_order_rows_source_row_key',
        'analysis_sales_order_rows',
        ['source_file_id', 'source_row_no'],
    )
    op.drop_column('analysis_sales_order_rows', 'data_version')
    op.drop_column('analysis_sales_order_rows', 'project_id')

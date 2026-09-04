"""Add country column to analysis_sales_order_rows.

支持多站点订单拆分：欧洲订单文件（UK/DE 混合）按行入库时，每个订单行记录其所属国家。
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '20260518_124'
down_revision = '20260517_123'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 添加 country 字段到 analysis_sales_order_rows 表
    op.add_column(
        'analysis_sales_order_rows',
        sa.Column('country', sa.String(2), nullable=False, server_default='US'),
    )

    # 创建索引以支持按 country 查询
    op.create_index(
        'idx_analysis_sales_order_country',
        'analysis_sales_order_rows',
        ['country'],
    )


def downgrade() -> None:
    op.drop_index('idx_analysis_sales_order_country', table_name='analysis_sales_order_rows')
    op.drop_column('analysis_sales_order_rows', 'country')
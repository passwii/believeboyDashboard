"""为 SKU 记录添加产品图片字段（与 FNSKU 标签对称）

在 product_costs 表（SKU 记录物理表）添加 6 列：
- product_image_r2_key / product_image_r2_url：R2 主图
- product_image_thumbnail_r2_key / product_image_thumbnail_r2_url：R2 缩略图
- product_image_uploaded_at / product_image_uploaded_by：上传元数据

Revision ID: 159
Revises: 158
Create Date: 2026-06-10
"""

from alembic import op
import sqlalchemy as sa


revision = "159"
down_revision = "158"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "product_costs",
        sa.Column("product_image_r2_key", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_r2_url", sa.String(length=1024), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_thumbnail_r2_key", sa.String(length=512), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_thumbnail_r2_url", sa.String(length=1024), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_uploaded_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "product_costs",
        sa.Column("product_image_uploaded_by", sa.String(length=128), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("product_costs", "product_image_uploaded_by")
    op.drop_column("product_costs", "product_image_uploaded_at")
    op.drop_column("product_costs", "product_image_thumbnail_r2_url")
    op.drop_column("product_costs", "product_image_thumbnail_r2_key")
    op.drop_column("product_costs", "product_image_r2_url")
    op.drop_column("product_costs", "product_image_r2_key")

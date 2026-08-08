"""crm 产品类目 2 表 + 种子数据（P6b）

crm_categories: 管理员维护的扁平类目词表（唯一 name + sort_order）。
crm_customer_categories: 客户 ↔ 类目多对多关联（PK 复合天然去重）。
灌 9 个亚马逊主流类目种子。纯增量，回滚 = drop 2 表。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "244"
down_revision: Union[str, None] = "243"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEED_CATEGORIES = [
    "家居",
    "3C",
    "服装",
    "家纺",
    "科学配件",
    "工业配件",
    "工具配件",
    "电动工具",
    "户外用品",
]


def upgrade() -> None:
    op.create_table(
        "crm_categories",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("name", name="uq_crm_categories_name"),
    )
    op.create_table(
        "crm_customer_categories",
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("category_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["customer_id"], ["crm_customers.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["category_id"], ["crm_categories.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("customer_id", "category_id"),
    )
    op.create_index("idx_ccc_category", "crm_customer_categories", ["category_id"])
    for i, name in enumerate(SEED_CATEGORIES):
        op.execute(
            sa.text(
                "INSERT INTO crm_categories (name, sort_order) "
                "VALUES (:name, :sort_order)"
            ).bindparams(name=name, sort_order=i)
        )


def downgrade() -> None:
    op.drop_table("crm_customer_categories")
    op.drop_table("crm_categories")

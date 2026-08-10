"""add crm_saved_views (Stage5-3 保存视图, BLF-589)

Revision ID: 254
Revises: 253
Create Date: 2026-08-10

BLF-589（CRM Stage5-3）：CordysCRM 7.3 Save View 模式落地——把客户/线索列表
的筛选状态（scope/keyword/filters/sort）保存为命名视图，前端「列表/表格
一键切换」复用。本迁移新建 crm_saved_views 表（个人视图 MVP + is_shared
列预留 admin 共享 V2）：

- idx_csv_owner_entity（owner_id, entity_type）：按人+域列个人视图；
- idx_csv_entity_shared（entity_type, is_shared）：按域列共享视图。

filters 列为 JSON（FilterCondition 数组，与列表端点 filters 参数同构；
白名单/运算符校验复用 filter_engine，不在迁移层约束）。

回滚：drop table（索引随表删除）。

编号协调：main head=253（BLF-588 #230 已合并部署，prod alembic=253）。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "254"
down_revision: str | None = "253"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "crm_saved_views",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("entity_type", sa.String(length=20), nullable=False),
        sa.Column("scope", sa.String(length=10), nullable=False),
        sa.Column("keyword", sa.String(length=200), nullable=True),
        sa.Column("filters", sa.JSON(), nullable=True),
        sa.Column("sort_by", sa.String(length=50), nullable=False),
        sa.Column("sort_order", sa.String(length=10), nullable=False),
        sa.Column("is_shared", sa.Boolean(), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_csv_owner_entity", "crm_saved_views", ["owner_id", "entity_type"]
    )
    op.create_index(
        "idx_csv_entity_shared", "crm_saved_views", ["entity_type", "is_shared"]
    )


def downgrade() -> None:
    op.drop_index("idx_csv_entity_shared", table_name="crm_saved_views")
    op.drop_index("idx_csv_owner_entity", table_name="crm_saved_views")
    op.drop_table("crm_saved_views")

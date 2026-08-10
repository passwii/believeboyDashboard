"""drop crm_opportunities 商机表（Stage5 逻辑打磨，BLF-588）

商机域已砍（用户拍板，见 BLF-586 子 issue BLF-588）：CrmOpportunity 模型 /
Opportunity schemas 无任何路由/服务引用，属死代码。表在 prod/dev 均已验证
0 行数据，安全删除。

回滚 = 按迁移 215 原定义重建表 + 2 索引（owner_id 为 String(36) 对齐
217 迁移后的类型）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "253"
down_revision: Union[str, None] = "252"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _timestamps():
    return (
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("crm_opportunities"):
        op.drop_index("idx_co_owner_stage", table_name="crm_opportunities")
        op.drop_index("idx_co_customer", table_name="crm_opportunities")
        op.drop_table("crm_opportunities")


def downgrade() -> None:
    op.create_table(
        "crm_opportunities",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column(
            "customer_id",
            sa.Integer(),
            sa.ForeignKey("crm_customers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("amount", sa.Numeric(16, 2), nullable=False, server_default="0"),
        sa.Column("stage", sa.String(20), nullable=False, server_default="lead_in"),
        sa.Column("owner_id", sa.String(36), nullable=True),
        sa.Column("expected_close_date", sa.String(10), nullable=True),
        sa.Column("probability", sa.Integer(), nullable=True),
        sa.Column("linked_project_id", sa.Integer(), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column(
            "is_deleted", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        *_timestamps(),
    )
    op.create_index("idx_co_customer", "crm_opportunities", ["customer_id"])
    op.create_index("idx_co_owner_stage", "crm_opportunities", ["owner_id", "stage"])

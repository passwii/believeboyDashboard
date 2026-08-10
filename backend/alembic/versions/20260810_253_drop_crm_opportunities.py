"""drop crm_opportunities (商机已拍板砍除)

Revision ID: 253
Revises: 252
Create Date: 2026-08-10

BLF-588（Stage5 逻辑打磨）：用户已拍板砍除商机（2026-07-18 评估 §3.1 维持 D8），
本轮清理 `CrmOpportunity` 模型/表/schema 死代码。本迁移：

1. 删除指向商机的孤儿跟进（crm_follows.entity_type='opportunity'）——
   crm_opportunities 表删除后这些行将悬挂无主（跟进按 entity_type+entity_id 多态寻址）；
2. 删除指向商机的孤儿审计（crm_audit_logs.entity_type='opportunity'）——同理；
3. 删除 crm_opportunities 表（含其 2 个索引 idx_co_customer / idx_co_owner_stage）。

历史上从未上线商机端点/UI（opportunity schema 无任何 import），预期上述
DELETE 大多为 0 行；保留清理仅为防止存量手工数据悬挂。

回滚：重建 crm_opportunities 表（迁移 215 同构）；已删除的孤儿跟进/审计不可恢复
（属已砍域的死数据，不承诺回滚）。

编号协调：main head=252（P6b #228 已合并部署，prod alembic=252）。
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "253"
down_revision: str | None = "252"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 孤儿清理：跟进/审计按 entity_type 多态寻址，表删除后悬挂无主
    op.execute("delete from crm_follows where entity_type = 'opportunity'")
    op.execute("delete from crm_audit_logs where entity_type = 'opportunity'")
    # 删表（连带索引 idx_co_customer / idx_co_owner_stage）
    op.drop_table("crm_opportunities")


def downgrade() -> None:
    # 与迁移 215（add crm tables）中 crm_opportunities 定义同构，恢复空表
    op.create_table(
        "crm_opportunities",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column(
            "customer_id",
            sa.Integer(),
            sa.ForeignKey("crm_customers.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("amount", sa.Numeric(16, 2), nullable=False),
        sa.Column("stage", sa.String(length=20), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column("expected_close_date", sa.String(length=10), nullable=True),
        sa.Column("probability", sa.Integer(), nullable=True),
        sa.Column("linked_project_id", sa.Integer(), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=36), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), nullable=False),
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
    op.create_index("idx_co_customer", "crm_opportunities", ["customer_id"])
    op.create_index("idx_co_owner_stage", "crm_opportunities", ["owner_id", "stage"])

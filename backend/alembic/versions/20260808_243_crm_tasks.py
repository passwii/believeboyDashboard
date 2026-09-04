"""add crm_tasks table (P7 task system, BLF-510)

Revision ID: 243
Revises: 242
Create Date: 2026-08-08

P7 任务系统（BLF-510）：待办管理载体，管「未来的义务」。
- 状态流转 pending/in_progress/done/cancelled；done 时写 completed_at。
- owner_id 为 user_accounts.id UUID（String(36)，与 crm_customers.owner_id 一致）；
  未指派 = null（不参与提醒）。
- customer_id/lead_id FK ON DELETE CASCADE（与 crm_contacts 一致）；业务删除以
  软删为主（is_deleted），软删不触发 FK，任务保留（历史待办不该消失）。
- 4 索引：owner+status（个人看板）、due_date（排序/提醒扫描）、customer/lead（联查）。

设计依据：docs/superpowers/specs/2026-08-08-crm-p7-task-system-design.md §5。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "243"
down_revision: Union[str, None] = "242"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("crm_tasks"):
        return
    op.create_table(
        "crm_tasks",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("due_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("priority", sa.String(10), nullable=False, server_default="medium"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("type", sa.String(20), nullable=False, server_default="custom"),
        sa.Column("owner_id", sa.String(36), nullable=True),
        sa.Column(
            "customer_id",
            sa.Integer(),
            sa.ForeignKey("crm_customers.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "lead_id",
            sa.Integer(),
            sa.ForeignKey("crm_leads.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("reminded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(36), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
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
        ),
    )
    op.create_index("idx_ct_owner_status", "crm_tasks", ["owner_id", "status"])
    op.create_index("idx_ct_due_date", "crm_tasks", ["due_date"])
    op.create_index("idx_ct_customer", "crm_tasks", ["customer_id"])
    op.create_index("idx_ct_lead", "crm_tasks", ["lead_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("crm_tasks"):
        op.drop_table("crm_tasks")

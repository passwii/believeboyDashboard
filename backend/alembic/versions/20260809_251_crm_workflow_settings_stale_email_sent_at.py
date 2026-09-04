"""crm workflow settings + stale email sent_at (P9-2, BLF-540)

Revision ID: 251
Revises: 250
Create Date: 2026-08-09

P9-2 7 天无跟进邮件（BLF-540）：
- ``crm_workflow_settings``：单行配置表（id=1 固定行），存 7 天无跟进的
  提醒阈值（``stale_days``，默认 7）与提醒邮件总开关（``stale_email_enabled``，
  默认开）。admin 设置页读写（GET/PUT /crm/settings/workflow）。
- ``crm_customers.stale_email_sent_at`` / ``crm_leads.stale_email_sent_at``：
  邮件提醒去重标记（沿用 crm_tasks.reminded_at 先例）。扫描命中后置位；
  实体在最近一次提醒后又产生新跟进（ref 前移）才重新进入待发集合。

注：本 PR 并行期曾用过 revision 246（与 PR #195 撞号后重排）。rebase 到
当前 main（250）后重排为 251 直接挂在 250 上，单链追加，无需 merge migration。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "251"
down_revision: Union[str, None] = "250"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not inspector.has_table("crm_workflow_settings"):
        op.create_table(
            "crm_workflow_settings",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("stale_days", sa.Integer(), nullable=False, server_default="7"),
            sa.Column(
                "stale_email_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
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
        # 单行配置：预置 id=1 默认行（stale_days=7, stale_email_enabled=true）
        op.execute(
            sa.text(
                "insert into crm_workflow_settings (id, stale_days, stale_email_enabled) "
                "values (1, 7, true) on conflict (id) do nothing"
            )
        )

    columns = {c["name"] for c in inspector.get_columns("crm_customers")}
    if "stale_email_sent_at" not in columns:
        op.add_column(
            "crm_customers",
            sa.Column("stale_email_sent_at", sa.DateTime(timezone=True), nullable=True),
        )

    columns = {c["name"] for c in inspector.get_columns("crm_leads")}
    if "stale_email_sent_at" not in columns:
        op.add_column(
            "crm_leads",
            sa.Column("stale_email_sent_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    for table in ("crm_leads", "crm_customers"):
        columns = {c["name"] for c in inspector.get_columns(table)}
        if "stale_email_sent_at" in columns:
            op.drop_column(table, "stale_email_sent_at")

    if inspector.has_table("crm_workflow_settings"):
        op.drop_table("crm_workflow_settings")

"""add crm_reminder_logs (P9-1 7 天无跟进提醒账本, BLF-539)

Revision ID: 245
Revises: 244
Create Date: 2026-08-09

P9 工作流自动化（BLF-538）子 issue 1（BLF-539）数据基础：
- `crm_reminder_logs`：7 天无跟进提醒的「去重 + 生命周期」账本。
  celery 每日 scan 命中 N 天未跟进实体时写入一条 active 记录（单次提醒语义，
  幂等：已有 active 记录则跳过）；跟进成功（follow_service.create_follow）后
  resolve 该实体记录，下次再 stale 可重新提醒。SSE 端点只推送 active 记录，
  按实体当前 owner 过滤推送对象。

设计依据：BLF-538 子 issue 清单 stage 1「P9-1 7 天无跟进提醒 cron + SSE」；
扫描口径复用 P3a sea_reclaim（客户 COALESCE(last_follow_at, created_at)，
线索 COALESCE(next_follow_at, created_at)，排除 signed/converted/discarded/已删/无主）。
后续 P9-2 邮件提醒复用同一账本（reminder_type 扩展）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "245"
down_revision: Union[str, None] = "244"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "crm_reminder_logs" in inspector.get_table_names():
        return
    op.create_table(
        "crm_reminder_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entity_type", sa.String(length=20), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("reminder_type", sa.String(length=30), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=True),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="active",
        ),
        sa.Column("reminded_at", sa.DateTime(timezone=True), nullable=False),
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
    op.create_index("idx_crl_entity", "crm_reminder_logs", ["entity_type", "entity_id"])
    op.create_index("idx_crl_owner_status", "crm_reminder_logs", ["owner_id", "status"])


def downgrade() -> None:
    op.drop_index("idx_crl_owner_status", table_name="crm_reminder_logs")
    op.drop_index("idx_crl_entity", table_name="crm_reminder_logs")
    op.drop_table("crm_reminder_logs")

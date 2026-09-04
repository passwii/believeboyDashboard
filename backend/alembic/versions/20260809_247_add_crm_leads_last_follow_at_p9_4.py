"""add crm_leads.last_follow_at (P9-4 公海重置机制, BLF-542)

Revision ID: 247
Revises: 245
Create Date: 2026-08-09 12:50:21.296704

P9 工作流自动化（BLF-538）子 issue 4（BLF-542）数据基础：
- `last_follow_at`（nullable，镜像 crm_customers.last_follow_at）：线索「最近一次跟进」时间戳。
  follow_service.create_follow 对线索跟进成功时写入 now（与客户一致），
  公海回收计时以此为基准：COALESCE(last_follow_at, next_follow_at, created_at) 距今 > N 天
  才回收 —— 跟进成功即重置 7 天计时，杜绝「刚跟进完但 next_follow_at 被清空 → 回退
  created_at → 被误回收」的漏洞（P9-3 的 next_follow_at 口径只覆盖约了下次跟进的场景）。
- 优先级把 last_follow_at 放最前：next_follow_at 只是「约定/提醒」语义，实际跟进行为
  才是回收计时的权威信号；存量数据 last_follow_at=NULL → 自动回退旧口径，无行为回归。
- 索引 idx_cl_last_follow（镜像 idx_cc_last_follow）：支撑每日扫描的排序/过滤。

设计依据：BLF-542 issue 描述「跟进成功后重置 7 天回收计时（last_follow_at 刷新联动）」
+ BLF-538 父 issue 设计纲要 P9.2「可在跟进成功时重置计时」。

编号协调：rev-id 246 已由 BLF-540 的 PR #196（crm_workflow_settings）占用（尚未合并），
故本迁移取 247、down_revision 仍为 245（独立链）。两 PR 合入 main 后需执行
`alembic merge heads --rev-id 248 -m "merge ..."` 恢复单链（BEL-492 撞车规则）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "247"
down_revision: Union[str, None] = "245"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("crm_leads")}
    if "last_follow_at" not in cols:
        op.add_column(
            "crm_leads",
            sa.Column("last_follow_at", sa.DateTime(timezone=True), nullable=True),
        )
    indexes = {ix["name"] for ix in inspector.get_indexes("crm_leads")}
    if "idx_cl_last_follow" not in indexes:
        op.create_index("idx_cl_last_follow", "crm_leads", ["last_follow_at"])


def downgrade() -> None:
    op.drop_index("idx_cl_last_follow", table_name="crm_leads")
    op.drop_column("crm_leads", "last_follow_at")

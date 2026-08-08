"""add crm_leads.entered_stage_at (P8 funnel stage dwell, BLF-517)

Revision ID: 244
Revises: 243
Create Date: 2026-08-08

P8 漏斗指标 service（BLF-517）数据基础（漏斗二层设计决策 #5，BLF-516）：
- `entered_stage_at`（nullable）：线索「进入当前阶段」的时间戳，status 变更时写入
  （create_lead / update_lead 状态变化 / convert_lead）。用于：
  * 阶段停留时长（dwell = now - entered_stage_at）→ 二层复盘面板「平均停留 / 卡点」
  * 按时间聚合的漏斗（本期流入 = entered_stage_at ∈ period）
- 不能从 CrmFollow.created_at 推导（改状态不一定伴随一条跟进），audit 仅 P4 起且只有
  summary 文本——故落字段（决策 #5 结论）。
- 历史数据为 NULL：停留时长回退用 updated_at（最后一次修改 ≈ 最近一次状态变更），
  时间维度不计入（快照 total 仍计）。
- 复合索引 (status, entered_stage_at)：支撑阶段明细列表 + 按时间聚合。

设计依据：docs/superpowers/plans/2026-07-30-crm-funnel-redesign.md §待决策 5
+ BLF-509 评论（2026-08-08 漏斗二层设计决策 · 决策 5 推荐 A）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "244"
down_revision: Union[str, None] = "243"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("crm_leads")}
    if "entered_stage_at" not in cols:
        op.add_column(
            "crm_leads",
            sa.Column("entered_stage_at", sa.DateTime(timezone=True), nullable=True),
        )
        # 存量回填（决策 #5 约定）：历史数据无进入阶段时间戳，用近似值
        # COALESCE(converted_at, updated_at) —— converted 用转化时间，其余用
        # 最近一次修改时间（≈ 最近一次状态变更）。精度损失已知：
        # 若最后修改是状态变更之外的编辑（如改备注），会略晚于真实进入时间。
        op.execute(
            "update crm_leads set entered_stage_at = coalesce(converted_at, updated_at) "
            "where entered_stage_at is null"
        )
    indexes = {ix["name"] for ix in inspector.get_indexes("crm_leads")}
    if "idx_cl_status_entered" not in indexes:
        op.create_index(
            "idx_cl_status_entered", "crm_leads", ["status", "entered_stage_at"]
        )


def downgrade() -> None:
    op.drop_index("idx_cl_status_entered", table_name="crm_leads")
    op.drop_column("crm_leads", "entered_stage_at")

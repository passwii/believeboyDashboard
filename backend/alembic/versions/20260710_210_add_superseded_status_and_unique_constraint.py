"""add_superseded_status_and_unique_constraint

Revision ID: 20260710_210
Revises: 20260710_209
Create Date: 2026-07-10

P0-3 决策：把历史重复 (sub, freq, report_date, triggered_by) 的
delivery_log 标记为 superseded 后，加唯一约束挡住后续重复派发。

数据迁移说明：
- 现状 PG 库（BLF）共有 664 行，545 个唯一组，多出 119 行重复（多为 SMTP
  重试窗口期的产物）。每组保留 MIN(id) 不动，其余 UPDATE 为
  status='superseded' + error_message 追加 'legacy duplicate of log_id=N'
- 加的唯一约束：(subscription_id, frequency, report_date, triggered_by)
- 不修改其他 status 列值；不触动订阅 / AI 摘要相关表
- downgrade：DROP 唯一约束。status='superseded' 历史数据不回退
  （不可逆，向代码注释说明）

down_revision 链 备注：
- 原写 "20260710_208"（worktree HEAD b62e7b06 时是 head）
- 上线时发现 production 已 apply 过 `20260710_209`（shipment-batch 那条
 迁移，在 main 分支后续 commit 中），改 down_revision 为 "20260710_209"
 以匹配实际 production alembic head（alembic 不允许跨 lineage 跳号）
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20260710_210"
down_revision = "20260710_209"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    constraint_names = {
        c["name"]
        for c in inspector.get_unique_constraints("scheduled_report_delivery_logs")
    }
    if "uq_delivery_log_dedup" in constraint_names:
        # 重建（例如本地开发时迁移重放）—— 先 drop 后面的 add 也已幂等；
        # 直接 return 跳过数据迁移，避免重复推 historical duplicate。
        return

    # 1. 数据迁移：每组 (sub, freq, report_date, triggered_by) 仅保留 MIN(id) 不变，
    #    其余 UPDATE 为 status='superseded' + error_message 写明 duplicate 来源。
    op.execute(
        """
        WITH ranked AS (
            SELECT id,
                   MIN(id) OVER (
                       PARTITION BY subscription_id,
                                    frequency,
                                    report_date,
                                    triggered_by
                   ) AS keep_id
              FROM scheduled_report_delivery_logs
        )
        UPDATE scheduled_report_delivery_logs AS t
           SET status = 'superseded',
               error_message = (
                   CASE
                       WHEN COALESCE(t.error_message, '') = '' THEN ''
                       ELSE t.error_message || '; '
                   END
                   || 'legacy duplicate of log_id=' || ranked.keep_id
               )
          FROM ranked
         WHERE t.id = ranked.id
           AND t.id <> ranked.keep_id;
        """
    )

    # 2. 加唯一约束。
    op.create_unique_constraint(
        "uq_delivery_log_dedup",
        "scheduled_report_delivery_logs",
        ["subscription_id", "frequency", "report_date", "triggered_by"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_delivery_log_dedup",
        "scheduled_report_delivery_logs",
        type_="unique",
    )
    # 不回退 superseded status——历史数据是动态分析时需要的痕跡。
    # 若需手工回退可执行：
    #   UPDATE scheduled_report_delivery_logs SET status='sent'
    #     WHERE status='superseded';

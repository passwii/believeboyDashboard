"""add_triggered_by_to_scheduled_report_delivery_logs

Revision ID: 20260706_202
Revises: 20260629_201
Create Date: 2026-07-06

新增 scheduled_report_delivery_logs.triggered_by 字段，区分自动调度 vs 人工补发。

背景：
    之前 _dispatch_one 自动调度路径不会初始化 dispatcher._summary_cache 全局状态，
    导致跨日反复命中前一天的缓存，截图/数据全部是旧值（BEL: 台账 7.4/7.5 数据错误 bug）。
    修复后仍需清理历史污染，但当时 delivery_log 模型没有显式区分"自动/补发"的字段，
    只能通过 report_date vs created_at::date 反推。

字段说明：
    auto    —— 由 scheduler._run_minutely_scan / 管理员 POST /trigger 触发
    manual  —— 由 ledger 页面"补发"按钮 / 管理员 force-resend 触发

回填：
    report_date != (created_at AT TIME ZONE 'Asia/Shanghai')::date::text 的历史记录
    推断为 manual（与当前代码语义一致）。
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = '20260706_202'
down_revision = '84d78e2677ee'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'scheduled_report_delivery_logs',
        sa.Column(
            'triggered_by',
            sa.String(length=20),
            nullable=False,
            server_default='auto',
            comment='auto=自动调度, manual=人工补发/重跑',
        ),
    )

    # 历史数据回填：report_date 与 created_at 的上海时区日期不同 ⇒ 补发
    op.execute(
        "UPDATE scheduled_report_delivery_logs "
        "SET triggered_by = 'manual' "
        "WHERE report_date != (created_at AT TIME ZONE 'Asia/Shanghai')::date::text"
    )


def downgrade() -> None:
    op.drop_column('scheduled_report_delivery_logs', 'triggered_by')
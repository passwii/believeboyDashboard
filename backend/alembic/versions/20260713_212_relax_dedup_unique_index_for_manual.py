"""relax_dedup_unique_index_for_manual

Revision ID: 20260713_212
Revises: 20260710_211
Create Date: 2026-07-13

产品决策（2026-07-13）：manual / 补发 不去重，同一订阅同一天可任意重发
（含失败态 / 历史日期）。原 P0-3 的 partial unique index 对
(sub, freq, report_date, triggered_by) 全量去重，导致 manual 重触发撞
IntegrityError（详见 2026-07-13 sub13 事故）。

现把 WHERE 收窄为 `triggered_by = 'auto'`：
- auto：仍保留"一天一次"去重 → 防 (30, daily, ..., auto) 自动双跑（P0-3 初衷）。
- manual：完全不在唯一索引覆盖范围 → 永不冲突，每天可任意补发。

upgrade：DROP 旧 index（若已存在）→ CREATE 新 index（WHERE 加 triggered_by='auto'）。
downgrade：DROP 新 → CREATE 旧（恢复原 P0-3 语义）。
幂等：开发环境重放时若 index 已符合预期则跳过重建。
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260713_212"
down_revision = "20260710_211"
branch_labels = None
depends_on = None

_NEW_WHERE = sa.text(
    "status NOT IN ('superseded', 'failed') AND triggered_by = 'auto'"
)
_OLD_WHERE = sa.text("status NOT IN ('superseded', 'failed')")

_INDEX_COLS = [
    "subscription_id",
    "frequency",
    "report_date",
    "triggered_by",
]


def _recreate_index(where: sa.TextClause) -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    index_names = {
        i["name"] for i in inspector.get_indexes("scheduled_report_delivery_logs")
    }
    if "uq_delivery_log_dedup" in index_names:
        op.drop_index(
            "uq_delivery_log_dedup",
            table_name="scheduled_report_delivery_logs",
        )
    op.create_index(
        "uq_delivery_log_dedup",
        "scheduled_report_delivery_logs",
        _INDEX_COLS,
        unique=True,
        postgresql_where=where,
        sqlite_where=where,
    )


def upgrade() -> None:
    _recreate_index(_NEW_WHERE)


def downgrade() -> None:
    _recreate_index(_OLD_WHERE)

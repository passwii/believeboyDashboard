"""seed crm rule engine MVP rule (BLF-544)

Revision ID: 250
Revises: 249
Create Date: 2026-08-09

P9-6 规则引擎执行器（BLF-544）MVP 种子规则：「客户创建 7 天内无跟进 → 提醒负责人」。
- rule：entity_type=customer, event_type=stale_follow_up, enabled
- condition：days_since_created gte 7 AND last_follow_at is_null
- action：notify_owner（复用 P9-1 SSE 提醒链路）

种子规则与 P9-1 硬编码扫描共用 CrmReminderLog active 去重，不会重复提醒；
P9-7 规则编辑器上线后 admin 可在此规则上启停/调整。

编号协调：main 现 head 为 249；246 由 BLF-540 PR #196（open）占用、248 预留给
merge head，故本迁移取 250、down_revision=249。
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "250"
down_revision: str | None = "249"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_RULE_NAME = "客户创建 7 天无跟进提醒（MVP）"


def upgrade() -> None:
    bind = op.get_bind()
    existing = bind.execute(
        sa.text("select id from crm_rules where name = :name limit 1"),
        {"name": _RULE_NAME},
    ).first()
    if existing is not None:
        return  # 已存在（幂等）

    rule_id = bind.execute(
        sa.text(
            """
            insert into crm_rules
              (name, description, entity_type, event_type, enabled, priority, created_by)
            values
              (:name, :desc, 'customer', 'stale_follow_up', true, 0, NULL)
            returning id
            """
        ),
        {
            "name": _RULE_NAME,
            "desc": "客户创建满 7 天且从未跟进 → 提醒负责人（P9 规则引擎 MVP，BLF-544）",
        },
    ).scalar()

    bind.execute(
        sa.text(
            """
            insert into crm_rule_conditions (rule_id, field, operator, value, sort_order)
            values (:rid, 'days_since_created', 'gte', '7', 0),
                   (:rid, 'last_follow_at', 'is_null', NULL, 1)
            """
        ),
        {"rid": rule_id},
    )
    bind.execute(
        sa.text(
            """
            insert into crm_rule_actions (rule_id, action_type, params, sort_order)
            values (:rid, 'notify_owner', cast(:params as json), 0)
            """
        ),
        {
            "rid": rule_id,
            "params": json.dumps({"message": "客户创建满 7 天无跟进，请及时跟进"}),
        },
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("delete from crm_rules where name = :name"), {"name": _RULE_NAME}
    )

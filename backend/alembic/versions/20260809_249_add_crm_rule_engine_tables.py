"""add crm rule engine tables (rule/condition/action, BLF-543)

Revision ID: 249
Revises: 247
Create Date: 2026-08-09

P9 规则引擎（BLF-538 子 issue 5）数据底座：「当 X 发生，做 Y」三表模型。
- `crm_rules`：规则头 —— 作用实体（customer/lead）、触发事件（event_type，
  MVP=stale_follow_up）、启停、优先级。
- `crm_rule_conditions`：条件（AND 语义，sort_order 求值）—— field/operator/value，
  MVP「客户创建 7 天内无跟进」= `days_since_created gte 7` + `last_follow_at is_null`。
- `crm_rule_actions`：动作（按 sort_order 顺序）—— action_type（MVP=notify_owner，
  复用 P9-1 SSE 通知链路）+ JSON params。

设计依据：BLF-543 issue 描述「规则引擎 schema：rule / condition / action 三表 +
迁移（Integer 主键，随 feature 分支走）」+ BLF-538 父 issue 设计纲要 P9.3
「可视化『当 X 发生，做 Y』编辑器；MVP 仅支持『客户创建 7 天内无跟进 → 提醒
负责人』；不实现复杂条件/复合动作/外部集成」。

编号协调：main 现 head 为 247；246 由 BLF-540 的 PR #196 占用（open），248 按
247 迁移文档约定预留给将来 merge head，故本迁移取 249、down_revision=247。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "249"
down_revision: Union[str, None] = "247"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("crm_rules"):
        return
    op.create_table(
        "crm_rules",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "entity_type", sa.String(20), nullable=False, server_default="customer"
        ),
        sa.Column(
            "event_type",
            sa.String(30),
            nullable=False,
            server_default="stale_follow_up",
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_by", sa.String(36), nullable=True),
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
    op.create_index("idx_crl_entity_event", "crm_rules", ["entity_type", "event_type"])
    op.create_index("idx_crl_enabled", "crm_rules", ["enabled"])

    op.create_table(
        "crm_rule_conditions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "rule_id",
            sa.Integer(),
            sa.ForeignKey("crm_rules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("field", sa.String(50), nullable=False),
        sa.Column("operator", sa.String(20), nullable=False, server_default="gte"),
        sa.Column("value", sa.String(200), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "idx_crc_rule_sort", "crm_rule_conditions", ["rule_id", "sort_order"]
    )

    op.create_table(
        "crm_rule_actions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "rule_id",
            sa.Integer(),
            sa.ForeignKey("crm_rules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "action_type", sa.String(30), nullable=False, server_default="notify_owner"
        ),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("idx_cra_rule_sort", "crm_rule_actions", ["rule_id", "sort_order"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    for table in ("crm_rule_actions", "crm_rule_conditions", "crm_rules"):
        if inspector.has_table(table):
            op.drop_table(table)

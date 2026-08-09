"""规则引擎 CRUD 服务（P9-7 编辑器后端, BLF-545 交接）。

前端「当 X 发生，做 Y」编辑器（settings 页）经此服务读写 `crm_rules` 三表：
- rule：规则头（entity_type / event_type / enabled / priority）。
- condition：AND 语义条件（field/operator/value，按 sort_order 求值）。
- action：动作（action_type / params，按 sort_order 顺序执行）。

设计要点：
- **整体写入**：create/update 时 conditions/actions 由请求体整体重建（先删后插，
  子表 id 由后端回填）；PATCH 未传 conditions/actions 时保留现有子表。
- **写时校验**：field 白名单在 schema 层（RULE_CONDITION_FIELDS）；action_type /
  entity_type / event_type 由 Literal 约束。执行器（rule_engine_service）对
  不支持的条件字段 fail-safe 跳过整条规则，故写时白名单与求值白名单同源。
- **原子性**：子表重建在单个事务内（调用方 commit）；删除 rule 由 FK CASCADE
  清理子表（迁移 249 ondelete=CASCADE）。
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.crm import CrmRule, CrmRuleAction, CrmRuleCondition
from app.schemas.crm import (
    RuleActionItem,
    RuleConditionItem,
    RuleCreate,
    RuleItem,
    RuleUpdate,
)


def _child_items(
    db: Session, rule_id: int
) -> tuple[list[CrmRuleCondition], list[CrmRuleAction]]:
    conditions = list(
        db.execute(
            select(CrmRuleCondition)
            .where(CrmRuleCondition.rule_id == rule_id)
            .order_by(CrmRuleCondition.sort_order, CrmRuleCondition.id)
        )
        .scalars()
        .all()
    )
    actions = list(
        db.execute(
            select(CrmRuleAction)
            .where(CrmRuleAction.rule_id == rule_id)
            .order_by(CrmRuleAction.sort_order, CrmRuleAction.id)
        )
        .scalars()
        .all()
    )
    return conditions, actions


def to_item(
    db: Session,
    rule: CrmRule,
    conditions: list[CrmRuleCondition] | None = None,
    actions: list[CrmRuleAction] | None = None,
) -> RuleItem:
    """ORM rule → RuleItem（响应 DTO，对齐前端 RuleDto）。"""
    if conditions is None or actions is None:
        conditions, actions = _child_items(db, rule.id)
    return RuleItem(
        id=rule.id,
        name=rule.name,
        description=rule.description,
        entity_type=rule.entity_type,
        event_type=rule.event_type,
        enabled=rule.enabled,
        priority=rule.priority,
        conditions=[
            RuleConditionItem(
                id=c.id,
                field=c.field,
                operator=c.operator,
                value=c.value,
                sort_order=c.sort_order,
            )
            for c in conditions
        ],
        actions=[
            RuleActionItem(
                id=a.id,
                action_type=a.action_type,
                params=a.params,
                sort_order=a.sort_order,
            )
            for a in actions
        ],
        created_by=rule.created_by,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


def list_rules(db: Session) -> list[RuleItem]:
    rules = list(
        db.execute(select(CrmRule).order_by(CrmRule.priority.desc(), CrmRule.id))
        .scalars()
        .all()
    )
    return [to_item(db, r) for r in rules]


def get_rule(db: Session, rule_id: int) -> CrmRule | None:
    return db.execute(select(CrmRule).where(CrmRule.id == rule_id)).scalar_one_or_none()


def _rebuild_children(
    db: Session, rule_id: int, payload: RuleCreate | RuleUpdate
) -> None:
    """整体重建 rule 的子表（先删后插，单事务内原子）。"""
    db.execute(delete(CrmRuleCondition).where(CrmRuleCondition.rule_id == rule_id))
    db.execute(delete(CrmRuleAction).where(CrmRuleAction.rule_id == rule_id))
    for cond in payload.conditions or []:
        db.add(
            CrmRuleCondition(
                rule_id=rule_id,
                field=cond.field,
                operator=cond.operator,
                value=cond.value,
                sort_order=cond.sort_order,
            )
        )
    for act in payload.actions or []:
        db.add(
            CrmRuleAction(
                rule_id=rule_id,
                action_type=act.action_type,
                params=act.params,
                sort_order=act.sort_order,
            )
        )


def create_rule(db: Session, payload: RuleCreate, user_id: str | None) -> CrmRule:
    """创建规则（含子表整体写入）。返回未 commit 的 ORM rule。"""
    rule = CrmRule(
        name=payload.name,
        description=payload.description,
        entity_type=payload.entity_type,
        event_type=payload.event_type,
        enabled=payload.enabled,
        priority=payload.priority,
        created_by=user_id,
    )
    db.add(rule)
    db.flush()
    _rebuild_children(db, rule.id, payload)
    return rule


def update_rule(
    db: Session, rule: CrmRule, payload: RuleUpdate, user_id: str | None = None
) -> CrmRule:
    """更新规则（PATCH 部分字段）。conditions/actions 传则整体替换，否则保留。"""
    data = payload.model_dump(exclude_unset=True)
    if "conditions" in data or "actions" in data:
        _rebuild_children(db, rule.id, payload)
    for field in (
        "name",
        "description",
        "entity_type",
        "event_type",
        "enabled",
        "priority",
    ):
        if field in data:
            setattr(rule, field, data[field])
    return rule


def delete_rule(db: Session, rule: CrmRule) -> None:
    """删除规则（子表 FK CASCADE 自动清理，迁移 249）。"""
    db.delete(rule)

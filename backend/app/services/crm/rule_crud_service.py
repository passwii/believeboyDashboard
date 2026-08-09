"""规则引擎 CRUD（P9-7b, BLF-561）。

`crm_rules` + `crm_rule_conditions` + `crm_rule_actions`（1:N）的管理接口：
- **list/get**：按 priority desc → id 排序，返回规则头 + 全部子表行。
- **create**：规则头 + conditions/actions 整体写入（原子重建，同一事务 flush）。
- **update**：PATCH 部分字段（exclude_unset 语义）；`conditions`/`actions` 出现
  即整体替换（先删后插，同事务，失败回滚不残留半套子表）。
- **delete**：删规则头，子表由 FK ON DELETE CASCADE 级联清理。

写时校验（`_validate_conditions`）：field/operator 白名单 + value 形状对齐
执行器（rule_engine_service）契约，避免写入即被 fail-safe 跳过的规则：
- 数值字段（days_since_created / days_since_last_follow）× 数值操作符 → value 须为整数；
- eq/ne → value 须非空；is_null/is_not_null → value 忽略。
校验失败抛 ValueError，由端点转 400（沿用 filter_engine 范式）。
"""

from __future__ import annotations

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models.crm import CrmRule, CrmRuleAction, CrmRuleCondition
from app.schemas.crm import (
    RuleActionInput,
    RuleConditionInput,
    RuleCreate,
    RuleItem,
    RuleUpdate,
)
from app.services.crm.rule_engine_service import (
    SUPPORTED_FIELDS,
)

_NUMERIC_OPS = {"gt", "gte", "lt", "lte"}
_VALUE_REQUIRED_OPS = {"eq", "ne"}


def list_rules(db: Session) -> list[CrmRule]:
    """全部规则（含启停），按 priority 降序 → id 升序。"""
    return list(
        db.execute(select(CrmRule).order_by(CrmRule.priority.desc(), CrmRule.id))
        .scalars()
        .all()
    )


def get_rule(db: Session, rule_id: int) -> CrmRule | None:
    return db.get(CrmRule, rule_id)


def to_rule_item(db: Session, rule: CrmRule) -> RuleItem:
    """ORM 规则头 + 子表行 → 响应 DTO（子表 id 回填）。"""
    conditions = list(
        db.execute(
            select(CrmRuleCondition)
            .where(CrmRuleCondition.rule_id == rule.id)
            .order_by(CrmRuleCondition.sort_order, CrmRuleCondition.id)
        )
        .scalars()
        .all()
    )
    actions = list(
        db.execute(
            select(CrmRuleAction)
            .where(CrmRuleAction.rule_id == rule.id)
            .order_by(CrmRuleAction.sort_order, CrmRuleAction.id)
        )
        .scalars()
        .all()
    )
    return RuleItem(
        id=rule.id,
        name=rule.name,
        description=rule.description,
        entity_type=rule.entity_type,
        event_type=rule.event_type,
        enabled=rule.enabled,
        priority=rule.priority,
        created_by=rule.created_by,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
        conditions=[
            {
                "id": c.id,
                "field": c.field,
                "operator": c.operator,
                "value": c.value,
                "sort_order": c.sort_order,
            }
            for c in conditions
        ],
        actions=[
            {
                "id": a.id,
                "action_type": a.action_type,
                "params": a.params,
                "sort_order": a.sort_order,
            }
            for a in actions
        ],
    )


def create_rule(db: Session, payload: RuleCreate, *, created_by: str | None) -> CrmRule:
    """创建规则（条件/动作整体写入，原子重建子表）。校验失败抛 ValueError。"""
    _validate_conditions(payload.conditions)
    rule = CrmRule(
        name=payload.name,
        description=payload.description,
        entity_type=payload.entity_type,
        event_type=payload.event_type,
        enabled=payload.enabled,
        priority=payload.priority,
        created_by=created_by,
    )
    db.add(rule)
    db.flush()
    _rebuild_conditions(db, rule.id, payload.conditions)
    _rebuild_actions(db, rule.id, payload.actions)
    db.flush()
    return rule


def update_rule(db: Session, rule: CrmRule, payload: RuleUpdate) -> CrmRule:
    """PATCH 部分字段更新；conditions/actions 出现即整体替换（原子）。"""
    updates = payload.model_dump(exclude_unset=True)
    conditions = updates.pop("conditions", None)
    actions = updates.pop("actions", None)
    if conditions is not None:
        condition_inputs = [RuleConditionInput(**c) for c in conditions]
        _validate_conditions(condition_inputs)
        _rebuild_conditions(db, rule.id, condition_inputs)
    if actions is not None:
        action_inputs = [RuleActionInput(**a) for a in actions]
        _validate_actions(action_inputs)
        _rebuild_actions(db, rule.id, action_inputs)
    for field, value in updates.items():
        setattr(rule, field, value)
    return rule


def delete_rule(db: Session, rule: CrmRule) -> None:
    """删除规则（子表由 FK CASCADE 清理；条件/动作显式删除保证 order 可确定）。"""
    db.execute(delete(CrmRuleCondition).where(CrmRuleCondition.rule_id == rule.id))
    db.execute(delete(CrmRuleAction).where(CrmRuleAction.rule_id == rule.id))
    db.delete(rule)


def _validate_conditions(conditions: list[RuleConditionInput]) -> None:
    if not conditions:
        raise ValueError("规则至少需要 1 条条件")
    for c in conditions:
        if c.field not in SUPPORTED_FIELDS:
            raise ValueError(
                f"不支持的 condition.field: {c.field!r}"
                f"（白名单：{sorted(SUPPORTED_FIELDS)}）"
            )
        if c.operator in _NUMERIC_OPS:
            _require_int_value(c)
        elif c.operator in _VALUE_REQUIRED_OPS and (
            c.value is None or c.value.strip() == ""
        ):
            raise ValueError(f"{c.field} {c.operator} 需要非空 value")


def _validate_actions(actions: list[RuleActionInput]) -> None:
    if not actions:
        raise ValueError("规则至少需要 1 条动作")


def _require_int_value(c: RuleConditionInput) -> None:
    value = c.value
    if value is None or value.strip() == "":
        raise ValueError(f"{c.field} {c.operator} 需要数字 value")
    try:
        int(value)
    except ValueError:
        raise ValueError(
            f"{c.field} {c.operator} 的 value 必须是整数: {value!r}"
        ) from None


def _rebuild_conditions(
    db: Session, rule_id: int, conditions: list[RuleConditionInput]
) -> None:
    db.execute(delete(CrmRuleCondition).where(CrmRuleCondition.rule_id == rule_id))
    for c in conditions:
        db.add(
            CrmRuleCondition(
                rule_id=rule_id,
                field=c.field,
                operator=c.operator,
                value=c.value,
                sort_order=c.sort_order,
            )
        )


def _rebuild_actions(db: Session, rule_id: int, actions: list[RuleActionInput]) -> None:
    db.execute(delete(CrmRuleAction).where(CrmRuleAction.rule_id == rule_id))
    for a in actions:
        db.add(
            CrmRuleAction(
                rule_id=rule_id,
                action_type=a.action_type,
                params=a.params,
                sort_order=a.sort_order,
            )
        )

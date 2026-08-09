"""规则引擎执行器（P9-6, BLF-544）。

celery beat 每日扫 `crm_rules`（enabled 规则），按 rule → condition（AND）→ action
的顺序求值执行。MVP 场景「客户创建 7 天内无跟进 → 提醒负责人」= 一条种子规则：

    rule:   entity_type=customer, event_type=stale_follow_up
    cond:   days_since_created gte 7      （创建 ≥7 天）
    cond:   last_follow_at is_null        （从未跟进）
    action: notify_owner                  （写 active 提醒记录，复用 P9-1 SSE 链路）

设计要点：
- **条件求值**：condition 为 AND 语义，按 sort_order 求值；field/operator 白名单
  求值（见 `_FIELD_RESOLVERS` / `_OPERATOR_FN`），规则含不支持字段/操作符时
  **跳过整条规则**（fail-safe，不影响其它规则，summary 记 skipped）。
- **动作执行**：action 按 sort_order 顺序执行；MVP 仅 `notify_owner` —— 复用
  `CrmReminderLog`（reminder_type=STALE_FOLLOW_UP + status=ACTIVE + owner 快照），
  SSE 端点（GET /crm/follow-ups/reminders/stream）自动拾取推送，前端 toast 复用。
- **幂等**：与 P9-1 `scan_stale_entities` 共用 active 记录去重——实体已有 active
  提醒则跳过；P9-1 硬编码扫描与本执行器互不重复提醒。
- **不自愈 resolve**：resolve 由跟进成功（follow_service.create_follow）闭环；
  P9-1 扫描启用时其自愈逻辑一并兜底。
- 实体无 owner（公海）不可提醒：notify_owner 跳过（不报错，计入 skipped_no_owner）。

队列：default（短任务，每日一次）。
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.crm import (
    CrmCustomer,
    CrmLead,
    CrmReminderLog,
    CrmReminderStatus,
    CrmReminderType,
    CrmRule,
    CrmRuleAction,
    CrmRuleCondition,
    CrmRuleConditionOperator,
)

logger = logging.getLogger(__name__)

# condition.field 支持白名单 → 实体字段解析器（返回原始值，由操作符函数比较）
# 实体统一视图：customer / lead 都提供 days_since_* / status；rating 仅 customer。
_FieldResolver = Callable[[object, datetime], object]


def _days_between(a: datetime | None, b: datetime) -> int | None:
    if a is None:
        return None
    return (b - a).days


def _res_days_since_created(entity, now: datetime) -> int | None:
    return _days_between(entity.created_at, now)  # type: ignore[attr-defined]


def _res_days_since_last_follow(entity, now: datetime) -> int | None:
    return _days_between(entity.last_follow_at, now)  # type: ignore[attr-defined]


def _res_last_follow_at(entity, now: datetime) -> datetime | None:
    return entity.last_follow_at  # type: ignore[attr-defined]


def _res_status(entity, now: datetime) -> str | None:
    return entity.status  # type: ignore[attr-defined]


def _res_rating(entity, now: datetime) -> str | None:
    return entity.rating  # type: ignore[attr-defined]


_FIELD_RESOLVERS: dict[str, _FieldResolver] = {
    "days_since_created": _res_days_since_created,
    "days_since_last_follow": _res_days_since_last_follow,
    "last_follow_at": _res_last_follow_at,
    "status": _res_status,
    "rating": _res_rating,
}


def _parse_numeric(value: str | None) -> int:
    """condition.value 转 int（numeric 比较）。非法时抛 ValueError。"""
    if value is None or value.strip() == "":
        raise ValueError(f"numeric condition 缺少 value: {value!r}")
    return int(value)


def _operator_gt(a: object, v: str | None) -> bool:
    """numeric gt —— value 解析失败抛 ValueError（fail-safe 跳过整条规则）。"""
    return a is not None and a > _parse_numeric(v)  # type: ignore[operator]


def _operator_gte(a: object, v: str | None) -> bool:
    return a is not None and a >= _parse_numeric(v)  # type: ignore[operator]


def _operator_lt(a: object, v: str | None) -> bool:
    return a is not None and a < _parse_numeric(v)  # type: ignore[operator]


def _operator_lte(a: object, v: str | None) -> bool:
    return a is not None and a <= _parse_numeric(v)  # type: ignore[operator]


def _operator_eq(a: object, v: str | None) -> bool:
    if v is None:
        return False
    if isinstance(a, int):
        return a == _parse_numeric(v)
    return a == v


def _operator_ne(a: object, v: str | None) -> bool:
    if v is None:
        return True
    if isinstance(a, int):
        return a != _parse_numeric(v)
    return a != v


def _operator_is_null(a: object, v: str | None) -> bool:
    return a is None


def _operator_is_not_null(a: object, v: str | None) -> bool:
    return a is not None


_OPERATOR_FN: dict[str, Callable[[object, str | None], bool]] = {
    CrmRuleConditionOperator.GT: _operator_gt,
    CrmRuleConditionOperator.GTE: _operator_gte,
    CrmRuleConditionOperator.LT: _operator_lt,
    CrmRuleConditionOperator.LTE: _operator_lte,
    CrmRuleConditionOperator.EQ: _operator_eq,
    CrmRuleConditionOperator.NE: _operator_ne,
    CrmRuleConditionOperator.IS_NULL: _operator_is_null,
    CrmRuleConditionOperator.IS_NOT_NULL: _operator_is_not_null,
}


def condition_supported(condition: CrmRuleCondition) -> bool:
    """condition 的 field/operator 是否在白名单内（fail-safe 前置校验）。"""
    return condition.field in _FIELD_RESOLVERS and condition.operator in _OPERATOR_FN


def evaluate_condition(entity, condition: CrmRuleCondition, now: datetime) -> bool:
    """求值单条 condition（AND 语义由调用方聚合）。不支持时抛 ValueError（fail-safe）。"""
    if not condition_supported(condition):
        raise ValueError(
            f"不支持的 condition: field={condition.field!r} operator={condition.operator!r}"
        )
    resolver = _FIELD_RESOLVERS[condition.field]
    fn = _OPERATOR_FN[condition.operator]
    return fn(resolver(entity, now), condition.value)


def _rule_conditions(db: Session, rule_id: int) -> list[CrmRuleCondition]:
    return list(
        db.execute(
            select(CrmRuleCondition)
            .where(CrmRuleCondition.rule_id == rule_id)
            .order_by(CrmRuleCondition.sort_order)
        )
        .scalars()
        .all()
    )


def _rule_actions(db: Session, rule_id: int) -> list[CrmRuleAction]:
    return list(
        db.execute(
            select(CrmRuleAction)
            .where(CrmRuleAction.rule_id == rule_id)
            .order_by(CrmRuleAction.sort_order)
        )
        .scalars()
        .all()
    )


def _load_entities(db: Session, entity_type: str) -> list:
    """加载实体候选集（未删除）。实体类与列名对齐 rule.entity_type。"""
    if entity_type == "customer":
        return list(
            db.execute(select(CrmCustomer).where(CrmCustomer.is_deleted.is_(False)))
            .scalars()
            .all()
        )
    if entity_type == "lead":
        return list(
            db.execute(select(CrmLead).where(CrmLead.is_deleted.is_(False)))
            .scalars()
            .all()
        )
    raise ValueError(f"不支持的 rule.entity_type: {entity_type!r}")


def _has_active_reminder(db: Session, entity_type: str, entity_id: int) -> bool:
    row = db.execute(
        select(CrmReminderLog.id).where(
            CrmReminderLog.reminder_type == CrmReminderType.STALE_FOLLOW_UP,
            CrmReminderLog.status == CrmReminderStatus.ACTIVE,
            CrmReminderLog.entity_type == entity_type,
            CrmReminderLog.entity_id == entity_id,
        )
    ).first()
    return row is not None


def _execute_notify_owner(
    db: Session,
    entity_type: str,
    entity,
    now: datetime,
) -> str:
    """notify_owner：写 active 提醒记录（复用 P9-1 SSE 链路）。

    返回执行结果标记：created / skipped_active / skipped_no_owner。
    """
    owner_id = entity.owner_id
    if owner_id is None:
        return "skipped_no_owner"
    if _has_active_reminder(db, entity_type, entity.id):
        return "skipped_active"
    db.add(
        CrmReminderLog(
            entity_type=entity_type,
            entity_id=entity.id,
            reminder_type=CrmReminderType.STALE_FOLLOW_UP,
            owner_id=owner_id,
            status=CrmReminderStatus.ACTIVE,
            reminded_at=now,
        )
    )
    return "created"


_ACTION_FN: dict[str, Callable[[Session, str, object, datetime], str]] = {
    "notify_owner": _execute_notify_owner,
}


def scan_rules(db: Session, *, now: datetime | None = None) -> dict:
    """扫全部 enabled 规则并执行（幂等）。返回执行摘要。"""
    moment = now or datetime.now(timezone.utc)
    rules = list(
        db.execute(
            select(CrmRule)
            .where(CrmRule.enabled.is_(True))
            .order_by(CrmRule.priority.desc(), CrmRule.id)
        )
        .scalars()
        .all()
    )

    summary: dict = {
        "rules_evaluated": len(rules),
        "rules_skipped_unsupported": 0,
        "entities_matched": 0,
        "notify_created": 0,
        "notify_skipped_active": 0,
        "notify_skipped_no_owner": 0,
        "per_rule": [],
    }

    for rule in rules:
        conditions = _rule_conditions(db, rule.id)
        actions = _rule_actions(db, rule.id)
        # 规则须同时有条件与动作；条件字段/操作符不支持 → 跳过整条规则（fail-safe）
        if not conditions or not actions:
            logger.warning("规则 %s(id=%s) 无条件或无动作，跳过", rule.name, rule.id)
            summary["rules_skipped_unsupported"] += 1
            summary["per_rule"].append(
                {"rule_id": rule.id, "name": rule.name, "matched": 0, "note": "empty"}
            )
            continue
        if not all(condition_supported(c) for c in conditions):
            logger.warning(
                "规则 %s(id=%s) 含不支持的条件字段/操作符，跳过", rule.name, rule.id
            )
            summary["rules_skipped_unsupported"] += 1
            summary["per_rule"].append(
                {
                    "rule_id": rule.id,
                    "name": rule.name,
                    "matched": 0,
                    "note": "unsupported",
                }
            )
            continue

        entities = _load_entities(db, rule.entity_type)
        matched = [
            e
            for e in entities
            if all(evaluate_condition(e, cond, moment) for cond in conditions)
        ]
        summary["entities_matched"] += len(matched)

        rule_result: dict = {
            "rule_id": rule.id,
            "name": rule.name,
            "matched": len(matched),
        }
        for entity in matched:
            for action in actions:
                fn = _ACTION_FN.get(action.action_type)
                if fn is None:
                    logger.warning(
                        "规则 %s(id=%s) 动作 %s 未实现，跳过",
                        rule.name,
                        rule.id,
                        action.action_type,
                    )
                    continue
                marker = fn(db, rule.entity_type, entity, moment)
                if marker == "created":
                    summary["notify_created"] += 1
                    rule_result.setdefault("created", 0)
                    rule_result["created"] += 1
                elif marker == "skipped_active":
                    summary["notify_skipped_active"] += 1
                elif marker == "skipped_no_owner":
                    summary["notify_skipped_no_owner"] += 1
        summary["per_rule"].append(rule_result)

    db.flush()
    return summary

"""P9 规则引擎三表模型契约测试（BLF-543）。

验证 rule / condition / action 三表的列、索引、FK 与枚举默认值，锁定 schema
接口供 BLF-544 执行器 / BLF-545 编辑器 / BLF-546 审计消费。纯模型层断言，不依赖数据库。
"""

from __future__ import annotations

from sqlalchemy import ForeignKey, inspect

from app.models.crm import (
    CrmRule,
    CrmRuleAction,
    CrmRuleActionType,
    CrmRuleCondition,
    CrmRuleConditionOperator,
    CrmRuleEntityType,
    CrmRuleEventType,
)


def _col_names(table) -> set[str]:
    return {c.name for c in table.columns}


def _index_names(table) -> set[str]:
    return {i.name for i in table.indexes}


def test_crm_rules_columns_and_indexes():
    cols = _col_names(CrmRule.__table__)
    for name in (
        "id",
        "name",
        "description",
        "entity_type",
        "event_type",
        "enabled",
        "priority",
        "created_by",
        "created_at",
        "updated_at",
    ):
        assert name in cols, f"crm_rules 缺列 {name}"
    assert CrmRule.__table__.c.id.primary_key
    assert CrmRule.__table__.c.id.autoincrement
    idx = _index_names(CrmRule.__table__)
    assert "idx_crl_entity_event" in idx
    assert "idx_crl_enabled" in idx


def test_crm_rule_conditions_columns_fk_and_indexes():
    cols = _col_names(CrmRuleCondition.__table__)
    for name in (
        "id",
        "rule_id",
        "field",
        "operator",
        "value",
        "sort_order",
        "created_at",
    ):
        assert name in cols, f"crm_rule_conditions 缺列 {name}"
    assert CrmRuleCondition.__table__.c.id.primary_key
    assert CrmRuleCondition.__table__.c.id.autoincrement
    rule_id_col = CrmRuleCondition.__table__.c.rule_id
    assert any(
        isinstance(fk, ForeignKey) and fk.target_fullname == "crm_rules.id"
        for fk in rule_id_col.foreign_keys
    )
    assert "idx_crc_rule_sort" in _index_names(CrmRuleCondition.__table__)


def test_crm_rule_actions_columns_fk_and_indexes():
    cols = _col_names(CrmRuleAction.__table__)
    for name in ("id", "rule_id", "action_type", "params", "sort_order", "created_at"):
        assert name in cols, f"crm_rule_actions 缺列 {name}"
    assert CrmRuleAction.__table__.c.id.primary_key
    assert CrmRuleAction.__table__.c.id.autoincrement
    rule_id_col = CrmRuleAction.__table__.c.rule_id
    assert any(
        isinstance(fk, ForeignKey) and fk.target_fullname == "crm_rules.id"
        for fk in rule_id_col.foreign_keys
    )
    assert "idx_cra_rule_sort" in _index_names(CrmRuleAction.__table__)


def test_rule_engine_enums_defaults():
    """枚举常量与列默认值对齐，锁定 MVP 语义。"""
    assert CrmRuleEntityType.CUSTOMER == "customer"
    assert CrmRuleEntityType.LEAD == "lead"
    assert CrmRuleEventType.STALE_FOLLOW_UP == "stale_follow_up"
    assert CrmRuleConditionOperator.GTE == "gte"
    assert CrmRuleConditionOperator.IS_NULL == "is_null"
    assert CrmRuleActionType.NOTIFY_OWNER == "notify_owner"

    assert CrmRule.__table__.c.entity_type.default.arg == "customer"
    assert CrmRule.__table__.c.event_type.default.arg == "stale_follow_up"
    assert CrmRule.__table__.c.enabled.default.arg is True
    assert CrmRuleCondition.__table__.c.operator.default.arg == "gte"
    assert CrmRuleAction.__table__.c.action_type.default.arg == "notify_owner"
    # 动作参数为 JSON 列
    assert str(CrmRuleAction.__table__.c.params.type) == "JSON"

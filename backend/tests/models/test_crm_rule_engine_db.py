"""P9 规则引擎三表 DB 往返测试（BLF-543）。

验证迁移 249 落库后三表可正常 CRUD：rule 带 condition/action 子表写入、
JSON params 往返、FK CASCADE 删除联动（依赖 TEST_DATABASE_URL，未设置时跳过）。
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app.models.crm import (
    CrmRule,
    CrmRuleAction,
    CrmRuleCondition,
)


@pytest.fixture(autouse=True)
def _clean_rule_tables(db_session):
    """每个测试前清空规则引擎三表（rule 级 CASCADE 先清主表即可）。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(text("truncate crm_rules restart identity cascade"))
        s.commit()
    finally:
        s.close()
    yield


def test_rule_with_conditions_and_actions_roundtrip(db_session):
    rule = CrmRule(
        name="客户 7 天无跟进提醒",
        description="MVP 规则：客户创建 7 天内无跟进 → 提醒负责人",
        entity_type="customer",
        event_type="stale_follow_up",
        enabled=True,
        priority=10,
    )
    db_session.add(rule)
    db_session.flush()

    db_session.add(
        CrmRuleCondition(
            rule_id=rule.id,
            field="days_since_created",
            operator="gte",
            value="7",
            sort_order=0,
        )
    )
    db_session.add(
        CrmRuleCondition(
            rule_id=rule.id,
            field="last_follow_at",
            operator="is_null",
            value=None,
            sort_order=1,
        )
    )
    db_session.add(
        CrmRuleAction(
            rule_id=rule.id,
            action_type="notify_owner",
            params={"message": "该客户已 7 天无跟进"},
            sort_order=0,
        )
    )
    db_session.commit()

    got = db_session.query(CrmRule).filter(CrmRule.name == "客户 7 天无跟进提醒").one()
    assert got.entity_type == "customer"
    assert got.event_type == "stale_follow_up"
    assert got.enabled is True
    assert got.priority == 10

    conds = (
        db_session.query(CrmRuleCondition)
        .filter(CrmRuleCondition.rule_id == got.id)
        .order_by(CrmRuleCondition.sort_order)
        .all()
    )
    assert [(c.field, c.operator, c.value) for c in conds] == [
        ("days_since_created", "gte", "7"),
        ("last_follow_at", "is_null", None),
    ]

    actions = (
        db_session.query(CrmRuleAction).filter(CrmRuleAction.rule_id == got.id).all()
    )
    assert len(actions) == 1
    assert actions[0].action_type == "notify_owner"
    assert actions[0].params == {"message": "该客户已 7 天无跟进"}


def test_delete_rule_cascades_conditions_and_actions(db_session):
    rule = CrmRule(name="待删规则", entity_type="lead", event_type="stale_follow_up")
    db_session.add(rule)
    db_session.flush()
    db_session.add(
        CrmRuleCondition(
            rule_id=rule.id, field="days_since_created", operator="gte", value="7"
        )
    )
    db_session.add(
        CrmRuleAction(rule_id=rule.id, action_type="notify_owner", params={})
    )
    db_session.commit()

    db_session.query(CrmRule).filter(CrmRule.id == rule.id).delete()
    db_session.commit()

    assert (
        db_session.query(CrmRuleCondition)
        .filter(CrmRuleCondition.rule_id == rule.id)
        .count()
        == 0
    )
    assert (
        db_session.query(CrmRuleAction).filter(CrmRuleAction.rule_id == rule.id).count()
        == 0
    )

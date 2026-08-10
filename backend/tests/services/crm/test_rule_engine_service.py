"""规则引擎执行器服务测试（P9-6, BLF-544）。

覆盖：condition 求值（白名单字段/操作符、fail-safe）、scan_rules 全流程
（MVP 种子规则命中 → notify_owner 写 active 提醒、幂等去重、无负责人跳过、
disabled 规则跳过、不支持条件跳过、lead 实体）、SSE 推送源联动。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.models.crm import (
    CrmCustomer,
    CrmLead,
    CrmReminderStatus,
    CrmReminderType,
    CrmRule,
    CrmRuleAction,
    CrmRuleCondition,
)
from app.services.crm.rule_engine_service import (
    evaluate_condition,
    scan_rules,
)

ALICE = "11111111-1111-1111-1111-111111111111"
BOB = "22222222-2222-2222-2222-222222222222"

NOW = datetime(2026, 8, 9, 9, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _clean_crm_tables(db_session):
    """每个测试前清空 CRM 表（含规则引擎三表 + 提醒账本）；
    teardown 时恢复迁移 250 种子规则，保持共享测试 DB 与迁移状态一致。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_reminder_logs, crm_audit_logs, crm_tasks, crm_follows, "
                "crm_contacts, crm_leads, crm_customers, "
                "crm_rules restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield
    # teardown：恢复迁移 250 种子规则（幂等，与 migration upgrade 同口径）
    s = SessionLocal()
    try:
        _restore_seed_rule(s)
    finally:
        s.close()


def _restore_seed_rule(s) -> None:
    """恢复 MVP 种子规则（对齐迁移 250：rule + 2 条件 + notify_owner 动作）。"""
    from app.models.crm import CrmRule, CrmRuleAction, CrmRuleCondition

    existing = s.query(CrmRule).filter(CrmRule.name == _SEED_RULE_NAME).first()
    if existing is not None:
        s.commit()
        return
    rule = CrmRule(
        name=_SEED_RULE_NAME,
        description="客户创建满 7 天且从未跟进 → 提醒负责人（P9 规则引擎 MVP，BLF-544）",
        entity_type="customer",
        event_type="stale_follow_up",
        enabled=True,
        priority=0,
    )
    s.add(rule)
    s.flush()
    s.add(
        CrmRuleCondition(
            rule_id=rule.id,
            field="days_since_created",
            operator="gte",
            value="7",
            sort_order=0,
        )
    )
    s.add(
        CrmRuleCondition(
            rule_id=rule.id,
            field="last_follow_at",
            operator="is_null",
            value=None,
            sort_order=1,
        )
    )
    s.add(
        CrmRuleAction(
            rule_id=rule.id,
            action_type="notify_owner",
            params={"message": "客户创建满 7 天无跟进，请及时跟进"},
            sort_order=0,
        )
    )
    s.commit()


_SEED_RULE_NAME = "客户创建 7 天无跟进提醒（MVP）"


def _mk_customer(db, name="客户A", owner=ALICE, **kw):
    c = CrmCustomer(name=name, owner_id=owner, **kw)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


def _mk_lead(db, name="线索A", owner=ALICE, **kw):
    lead = CrmLead(name=name, owner_id=owner, **kw)
    db.add(lead)
    db.commit()
    db.refresh(lead)
    return lead


def _set_created_at(db, table, id_, ts):
    db.execute(
        text(f"update {table} set created_at=:t where id=:i"),
        {"t": ts, "i": id_},
    )
    db.commit()


def _mk_rule(db, name="MVP 规则", entity_type="customer", enabled=True, **kw):
    rule = CrmRule(
        name=name,
        entity_type=entity_type,
        event_type="stale_follow_up",
        enabled=enabled,
        **kw,
    )
    db.add(rule)
    db.flush()
    return rule


def _add_cond(db, rule, field, operator, value, sort_order):
    db.add(
        CrmRuleCondition(
            rule_id=rule.id,
            field=field,
            operator=operator,
            value=value,
            sort_order=sort_order,
        )
    )


def _add_action(db, rule, action_type="notify_owner", params=None, sort_order=0):
    db.add(
        CrmRuleAction(
            rule_id=rule.id,
            action_type=action_type,
            params=params or {},
            sort_order=sort_order,
        )
    )


def _active_logs(db):
    return db.execute(
        text(
            "select entity_type, entity_id, owner_id, status, reminder_type "
            "from crm_reminder_logs where status='active' order by id"
        )
    ).all()


def _old(days=8) -> datetime:
    return NOW - timedelta(days=days)


# ─── condition 求值 ───────────────────────────────────────────────────────────


def test_evaluate_days_since_created_gte(db_session):
    c = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", c.id, _old(10))
    cond = CrmRuleCondition(field="days_since_created", operator="gte", value="7")
    assert evaluate_condition(c, cond, NOW) is True

    _set_created_at(db_session, "crm_customers", c.id, _old(3))
    assert evaluate_condition(c, cond, NOW) is False


def test_evaluate_last_follow_at_is_null(db_session):
    c = _mk_customer(db_session, last_follow_at=NOW - timedelta(days=1))
    cond = CrmRuleCondition(field="last_follow_at", operator="is_null", value=None)
    assert evaluate_condition(c, cond, NOW) is False

    c2 = _mk_customer(db_session, name="客户B")
    assert evaluate_condition(c2, cond, NOW) is True


def test_evaluate_status_and_rating_eq(db_session):
    c = _mk_customer(db_session, status="active", rating="A")
    assert (
        evaluate_condition(
            c, CrmRuleCondition(field="status", operator="eq", value="active"), NOW
        )
        is True
    )
    assert (
        evaluate_condition(
            c, CrmRuleCondition(field="rating", operator="ne", value="C"), NOW
        )
        is True
    )


def test_evaluate_unsupported_field_raises(db_session):
    c = _mk_customer(db_session)
    cond = CrmRuleCondition(field="no_such_field", operator="gte", value="7")
    with pytest.raises(ValueError):
        evaluate_condition(c, cond, NOW)


def test_evaluate_unsupported_operator_raises(db_session):
    c = _mk_customer(db_session)
    cond = CrmRuleCondition(field="status", operator="contains", value="a")
    with pytest.raises(ValueError):
        evaluate_condition(c, cond, NOW)


# ─── scan_rules：MVP 全流程 ───────────────────────────────────────────────────


def test_scan_mvp_rule_creates_reminder_for_stale_customer(db_session):
    """客户创建 ≥7 天 + 从未跟进 → notify_owner 写 active 提醒。"""
    rule = _mk_rule(db_session)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session, name="老客户")
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))
    recent = _mk_customer(db_session, name="新客户")
    _set_created_at(db_session, "crm_customers", recent.id, _old(2))
    _mk_customer(db_session, name="跟过客户", last_follow_at=_old(1))

    result = scan_rules(db_session, now=NOW)

    assert result["rules_evaluated"] == 1
    assert result["rules_skipped_unsupported"] == 0
    assert result["entities_matched"] == 1
    assert result["notify_created"] == 1
    assert result["notify_skipped_active"] == 0
    assert result["notify_skipped_no_owner"] == 0

    rows = _active_logs(db_session)
    assert len(rows) == 1
    assert rows[0][0] == "customer"
    assert rows[0][1] == stale.id
    assert rows[0][2] == ALICE
    assert rows[0][3] == CrmReminderStatus.ACTIVE
    assert rows[0][4] == CrmReminderType.STALE_FOLLOW_UP


def test_scan_is_idempotent_active_log_dedup(db_session):
    """第二次扫描不再重复写提醒（单次提醒语义）。"""
    rule = _mk_rule(db_session)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    scan_rules(db_session, now=NOW)
    result2 = scan_rules(db_session, now=NOW)

    assert result2["notify_created"] == 0
    assert result2["notify_skipped_active"] == 1
    assert len(_active_logs(db_session)) == 1


def test_scan_skips_customer_without_owner(db_session):
    """无负责人（公海）不可提醒 → skipped_no_owner，不写记录。"""
    rule = _mk_rule(db_session)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    sea = _mk_customer(db_session, name="公海客户", owner=None)
    _set_created_at(db_session, "crm_customers", sea.id, _old(10))

    result = scan_rules(db_session, now=NOW)

    assert result["entities_matched"] == 1
    assert result["notify_skipped_no_owner"] == 1
    assert result["notify_created"] == 0
    assert _active_logs(db_session) == []


def test_scan_disabled_rule_not_evaluated(db_session):
    rule = _mk_rule(db_session, enabled=False)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    result = scan_rules(db_session, now=NOW)
    assert result["rules_evaluated"] == 0
    assert _active_logs(db_session) == []


def test_scan_skips_rule_with_unsupported_condition(db_session):
    """规则含不支持条件 → 跳过整条规则（fail-safe），不影响其它规则。"""
    bad = _mk_rule(db_session, name="坏规则")
    _add_cond(db_session, bad, "no_such_field", "gte", "7", 0)
    _add_action(db_session, bad)

    good = _mk_rule(db_session, name="好规则", priority=5)
    _add_cond(db_session, good, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, good, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, good)
    db_session.commit()

    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    result = scan_rules(db_session, now=NOW)

    assert result["rules_evaluated"] == 2
    assert result["rules_skipped_unsupported"] == 1
    assert result["entities_matched"] == 1
    assert result["notify_created"] == 1


def test_scan_lead_entity_type(db_session):
    """rule.entity_type=lead 时扫线索表。"""
    rule = _mk_rule(db_session, entity_type="lead")
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_lead(db_session, name="老线索")
    _set_created_at(db_session, "crm_leads", stale.id, _old(10))

    result = scan_rules(db_session, now=NOW)

    assert result["entities_matched"] == 1
    assert result["notify_created"] == 1
    rows = _active_logs(db_session)
    assert rows[0][0] == "lead"
    assert rows[0][1] == stale.id


def test_scan_rule_without_actions_noop(db_session):
    """规则无条件或动作 → 跳过（不炸）。"""
    _mk_rule(db_session)
    db_session.commit()
    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    result = scan_rules(db_session, now=NOW)
    assert result["rules_skipped_unsupported"] == 1
    assert _active_logs(db_session) == []


def test_scan_resolved_log_allows_re_remind(db_session):
    """跟进后 resolve → 下次扫描可重新提醒（循环闭环）。"""
    from app.services.crm.follow_up_reminder_service import resolve_entity_reminders

    rule = _mk_rule(db_session)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    scan_rules(db_session, now=NOW)
    assert resolve_entity_reminders(db_session, "customer", stale.id) == 1
    db_session.commit()

    result2 = scan_rules(db_session, now=NOW)
    assert result2["notify_created"] == 1
    assert len(_active_logs(db_session)) == 1


def test_migration_250_seed_rule_end_to_end(db_session):
    """迁移 250 种子规则（重建后）→ 执行器全流程：老客户命中、新客户不命中。

    迁移升级后种子规则即存在于 crm_rules；本测试显式重建（对齐迁移数据），
    验证 MVP 种子规则的 field/operator/action 契约可被执行器消费，且提醒记录
    被 P9-1 SSE 推送源（list_user_stale_reminders）拾取。
    """
    _restore_seed_rule(db_session)
    stale = _mk_customer(db_session, name="老客户A")
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))
    recent = _mk_customer(db_session, name="新客户B")
    _set_created_at(db_session, "crm_customers", recent.id, _old(2))

    result = scan_rules(db_session, now=NOW)

    assert result["rules_evaluated"] == 1
    assert result["entities_matched"] == 1
    assert result["notify_created"] == 1
    rows = _active_logs(db_session)
    assert rows[0][0] == "customer"
    assert rows[0][1] == stale.id
    assert rows[0][2] == ALICE

    # SSE 推送源联动：owner=ALICE 的 active 记录可被拾取
    from app.services.crm.follow_up_reminder_service import list_user_stale_reminders

    pushed = list_user_stale_reminders(db_session, user_id=ALICE, now=NOW, days=7)
    assert [p["entity_id"] for p in pushed] == [stale.id]


# ─── 触发结果审计（P9-8, BLF-546）：scan_rules 写 entity_type='rule' 审计日志 ───


def _rule_audit_logs(db):
    return db.execute(
        text(
            "select entity_id, action, actor_id, summary from crm_audit_logs "
            "where entity_type='rule' order by id"
        )
    ).all()


def test_scan_writes_trigger_audit_for_matched_rule(db_session):
    """规则命中实体 → 写 trigger 审计日志（actor_id=None 系统触发）。"""
    rule = _mk_rule(db_session)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session, name="老客户")
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))
    recent = _mk_customer(db_session, name="新客户")
    _set_created_at(db_session, "crm_customers", recent.id, _old(2))

    scan_rules(db_session, now=NOW)

    logs = _rule_audit_logs(db_session)
    assert len(logs) == 1
    entity_id, action, actor_id, summary = logs[0]
    assert entity_id == rule.id
    assert action == "trigger"
    assert actor_id is None
    assert "命中 1 实体" in summary
    assert "新建提醒 1" in summary


def test_scan_writes_trigger_audit_for_skipped_rule(db_session):
    """规则被 fail-safe 跳过（不支持条件）→ 审计日志记录跳过原因。"""
    bad = _mk_rule(db_session, name="坏规则")
    _add_cond(db_session, bad, "no_such_field", "gte", "7", 0)
    _add_action(db_session, bad)
    db_session.commit()

    scan_rules(db_session, now=NOW)

    logs = _rule_audit_logs(db_session)
    assert len(logs) == 1
    entity_id, action, actor_id, summary = logs[0]
    assert entity_id == bad.id
    assert action == "trigger"
    assert actor_id is None
    assert "跳过" in summary
    assert "坏规则" in summary


def test_scan_writes_trigger_audit_for_empty_rule(db_session):
    """规则无条件或动作 → 审计日志记录跳过原因。"""
    _mk_rule(db_session)
    db_session.commit()

    scan_rules(db_session, now=NOW)

    logs = _rule_audit_logs(db_session)
    assert len(logs) == 1
    assert logs[0][1] == "trigger"
    assert "跳过" in logs[0][3]
    assert "无条件或无动作" in logs[0][3]


def test_scan_disabled_rule_no_trigger_audit(db_session):
    """disabled 规则不参与扫描 → 不写 trigger 审计日志。"""
    rule = _mk_rule(db_session, enabled=False)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    scan_rules(db_session, now=NOW)

    assert _rule_audit_logs(db_session) == []


def test_scan_trigger_audit_idempotent_dedup_counts(db_session):
    """第二次扫描（已有 active 提醒）→ 审计摘要记录「去重跳过」计数。"""
    rule = _mk_rule(db_session)
    _add_cond(db_session, rule, "days_since_created", "gte", "7", 0)
    _add_cond(db_session, rule, "last_follow_at", "is_null", None, 1)
    _add_action(db_session, rule)
    db_session.commit()

    stale = _mk_customer(db_session)
    _set_created_at(db_session, "crm_customers", stale.id, _old(10))

    scan_rules(db_session, now=NOW)
    scan_rules(db_session, now=NOW)

    logs = _rule_audit_logs(db_session)
    assert len(logs) == 2
    assert "新建提醒 1" in logs[0][3]
    assert "去重跳过 1" in logs[1][3]

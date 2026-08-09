"""规则引擎 CRUD API 集成测试（P9-7b, BLF-561）。

覆盖 `/api/v1/crm/rules`（仅 admin，require_admin）：
- GET 全部规则（含 conditions/actions 子表 id 回填）
- POST 创建（整体写入 + created_by 回填 + 201）
- PATCH 部分字段（enabled 启停 / 名称 / 条件整体替换）
- DELETE 删除（CASCADE 子表）
- 权限：非管理员 403；404；校验失败 400（field 白名单 / value 形状）
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

_SEED_RULE_NAME = "客户创建 7 天无跟进提醒（MVP）"


@pytest.fixture(autouse=True)
def _clean_rule_tables(db_session):
    """每个测试前清空规则引擎三表（独立 session + commit）；teardown 恢复
    迁移 250 种子规则，保持共享测试 DB 与迁移状态一致（对齐服务层测试范式）。"""
    from app.db.session import SessionLocal

    s = SessionLocal()
    try:
        s.execute(
            text(
                "truncate crm_rules, crm_rule_conditions, crm_rule_actions "
                "restart identity cascade"
            )
        )
        s.commit()
    finally:
        s.close()
    yield
    s = SessionLocal()
    try:
        _restore_seed_rule(s)
    finally:
        s.close()


def _restore_seed_rule(s) -> None:
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


def _rule_payload(**overrides):
    payload = {
        "name": "客户 7 天无跟进提醒",
        "description": "测试规则",
        "entity_type": "customer",
        "event_type": "stale_follow_up",
        "enabled": True,
        "priority": 0,
        "conditions": [
            {
                "field": "days_since_created",
                "operator": "gte",
                "value": "7",
                "sort_order": 0,
            },
            {
                "field": "last_follow_at",
                "operator": "is_null",
                "value": None,
                "sort_order": 1,
            },
        ],
        "actions": [
            {"action_type": "notify_owner", "params": None, "sort_order": 0},
        ],
    }
    payload.update(overrides)
    return payload


def _child_counts(db_session) -> tuple[int, int]:
    rows = db_session.execute(
        text(
            "select "
            "(select count(*) from crm_rule_conditions), "
            "(select count(*) from crm_rule_actions)"
        )
    ).one()
    return int(rows[0]), int(rows[1])


# ─── GET ──────────────────────────────────────────────────────────────────────


def test_list_rules_admin_empty(client, admin_headers):
    r = client.get("/api/v1/crm/rules", headers=admin_headers)
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_list_rules_admin_with_children(client, db_session, admin_headers):
    rule = _create_via_payload(client, admin_headers)

    r = client.get("/api/v1/crm/rules", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body) == 1
    assert body[0]["id"] == rule["id"]
    assert body[0]["name"] == "客户 7 天无跟进提醒"
    assert len(body[0]["conditions"]) == 2
    assert len(body[0]["actions"]) == 1
    # 子表 id 由后端回填
    assert all("id" in c for c in body[0]["conditions"])
    assert all("id" in a for a in body[0]["actions"])


def test_list_rules_operator_forbidden(client, operator_headers):
    r = client.get("/api/v1/crm/rules", headers=operator_headers)
    assert r.status_code == 403, r.text


# ─── POST ─────────────────────────────────────────────────────────────────────


def test_create_rule_admin(client, admin_headers):
    r = client.post("/api/v1/crm/rules", json=_rule_payload(), headers=admin_headers)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "客户 7 天无跟进提醒"
    assert body["entity_type"] == "customer"
    assert body["event_type"] == "stale_follow_up"
    assert body["enabled"] is True
    assert body["priority"] == 0
    assert body["created_by"] == admin_headers["X-User-Id"]
    assert body["created_at"] and body["updated_at"]
    assert len(body["conditions"]) == 2
    assert len(body["actions"]) == 1
    assert body["actions"][0]["action_type"] == "notify_owner"


def test_create_rule_operator_forbidden(client, operator_headers):
    r = client.post("/api/v1/crm/rules", json=_rule_payload(), headers=operator_headers)
    assert r.status_code == 403, r.text


def test_create_rule_unsupported_field_400(client, admin_headers):
    payload = _rule_payload()
    payload["conditions"] = [
        {"field": "no_such_field", "operator": "gte", "value": "7", "sort_order": 0}
    ]
    r = client.post("/api/v1/crm/rules", json=payload, headers=admin_headers)
    assert r.status_code == 400, r.text


def test_create_rule_numeric_value_400(client, admin_headers):
    payload = _rule_payload()
    payload["conditions"] = [
        {
            "field": "days_since_created",
            "operator": "gte",
            "value": "七天",
            "sort_order": 0,
        }
    ]
    r = client.post("/api/v1/crm/rules", json=payload, headers=admin_headers)
    assert r.status_code == 400, r.text


def test_create_rule_eq_missing_value_400(client, admin_headers):
    payload = _rule_payload()
    payload["conditions"] = [
        {"field": "status", "operator": "eq", "value": None, "sort_order": 0}
    ]
    r = client.post("/api/v1/crm/rules", json=payload, headers=admin_headers)
    assert r.status_code == 400, r.text


def test_create_rule_empty_conditions_422(client, admin_headers):
    payload = _rule_payload()
    payload["conditions"] = []
    r = client.post("/api/v1/crm/rules", json=payload, headers=admin_headers)
    assert r.status_code == 422, r.text


def test_create_rule_bad_operator_422(client, admin_headers):
    payload = _rule_payload()
    payload["conditions"] = [
        {"field": "status", "operator": "contains", "value": "a", "sort_order": 0}
    ]
    r = client.post("/api/v1/crm/rules", json=payload, headers=admin_headers)
    assert r.status_code == 422, r.text


# ─── PATCH ────────────────────────────────────────────────────────────────────


def test_patch_enabled_toggle_preserves_children(client, admin_headers):
    rule = _create_via_payload(client, admin_headers)

    r = client.patch(
        f"/api/v1/crm/rules/{rule['id']}",
        json={"enabled": False},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is False
    assert body["name"] == rule["name"]
    # 未传 conditions/actions → 子表保持不变
    assert len(body["conditions"]) == 2
    assert len(body["actions"]) == 1


def test_patch_name_only(client, admin_headers):
    rule = _create_via_payload(client, admin_headers)

    r = client.patch(
        f"/api/v1/crm/rules/{rule['id']}",
        json={"name": "改名后的规则"},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "改名后的规则"
    assert body["entity_type"] == "customer"


def test_patch_conditions_atomic_replace(client, db_session, admin_headers):
    rule = _create_via_payload(client, admin_headers)
    old_condition_ids = {c["id"] for c in rule["conditions"]}
    assert _child_counts(db_session) == (2, 1)

    new_conditions = [
        {
            "field": "days_since_created",
            "operator": "gte",
            "value": "14",
            "sort_order": 0,
        }
    ]
    r = client.patch(
        f"/api/v1/crm/rules/{rule['id']}",
        json={"conditions": new_conditions},
        headers=admin_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["conditions"]) == 1
    assert body["conditions"][0]["value"] == "14"
    # 旧子表行被替换（新 id，非原 id）
    assert body["conditions"][0]["id"] not in old_condition_ids
    # 动作子表未受影响
    assert len(body["actions"]) == 1
    assert _child_counts(db_session) == (1, 1)


def test_patch_invalid_field_400_rolls_back(client, db_session, admin_headers):
    """整体替换校验失败 → 400 且原条件保留（同事务回滚，不残留半套）。"""
    rule = _create_via_payload(client, admin_headers)
    assert _child_counts(db_session) == (2, 1)

    payload = {
        "conditions": [
            {"field": "no_such_field", "operator": "gte", "value": "7", "sort_order": 0}
        ]
    }
    r = client.patch(
        f"/api/v1/crm/rules/{rule['id']}", json=payload, headers=admin_headers
    )
    assert r.status_code == 400, r.text
    assert _child_counts(db_session) == (2, 1)  # 未回滚/未残留


def test_patch_rule_not_found_404(client, admin_headers):
    r = client.patch(
        "/api/v1/crm/rules/99999", json={"enabled": False}, headers=admin_headers
    )
    assert r.status_code == 404, r.text


def test_patch_rule_operator_forbidden(client, operator_headers):
    r = client.patch(
        "/api/v1/crm/rules/1", json={"enabled": False}, headers=operator_headers
    )
    assert r.status_code == 403, r.text


# ─── DELETE ───────────────────────────────────────────────────────────────────


def test_delete_rule_cascades_children(client, db_session, admin_headers):
    rule = _create_via_payload(client, admin_headers)
    assert _child_counts(db_session) == (2, 1)

    r = client.delete(f"/api/v1/crm/rules/{rule['id']}", headers=admin_headers)
    assert r.status_code == 204, r.text
    assert _child_counts(db_session) == (0, 0)

    r2 = client.get("/api/v1/crm/rules", headers=admin_headers)
    assert r2.status_code == 200, r2.text
    assert r2.json() == []


def test_delete_rule_not_found_404(client, admin_headers):
    r = client.delete("/api/v1/crm/rules/99999", headers=admin_headers)
    assert r.status_code == 404, r.text


def test_delete_rule_operator_forbidden(client, operator_headers):
    r = client.delete("/api/v1/crm/rules/1", headers=operator_headers)
    assert r.status_code == 403, r.text


# ─── helpers ──────────────────────────────────────────────────────────────────


def _create_via_payload(client, headers) -> dict:
    r = client.post("/api/v1/crm/rules", json=_rule_payload(), headers=headers)
    assert r.status_code == 201, r.text
    return r.json()

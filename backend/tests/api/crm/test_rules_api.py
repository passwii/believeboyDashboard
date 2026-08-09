"""规则引擎 CRUD API 集成测试 — BLF-545 后端交接。

覆盖：GET/POST /api/v1/crm/rules + PATCH/DELETE /api/v1/crm/rules/{id}
- 管理员可全流程（创建 → 列表 → 更新 → 删除），DTO 对齐前端 RuleDto
- 非管理员 → 403（require_admin）
- conditions/actions 整体重建（先删后插、子表 id 回填）
- PATCH 部分字段（enabled 启停 / 仅改 name 不影响子表）
- 删除 CASCADE 清理子表
- 写时校验：condition.field 白名单 / 空 conditions 拒绝
"""

from __future__ import annotations

BASE = "/api/v1/crm/rules"


def _payload(**kw):
    """MVP 规则入参（对齐迁移 250 种子形态）。"""
    body = {
        "name": "客户 7 天无跟进提醒",
        "description": "客户创建满 7 天且从未跟进 → 提醒负责人",
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
            {
                "action_type": "notify_owner",
                "params": {"message": "请及时跟进"},
                "sort_order": 0,
            }
        ],
    }
    body.update(kw)
    return body


# ---------------- 权限 ----------------


def test_rules_require_admin(client, operator_headers):
    """非管理员访问规则 CRUD → 403。"""
    assert client.get(BASE, headers=operator_headers).status_code == 403
    assert (
        client.post(BASE, json=_payload(), headers=operator_headers).status_code == 403
    )
    assert (
        client.patch(
            f"{BASE}/1", json={"enabled": False}, headers=operator_headers
        ).status_code
        == 403
    )
    assert client.delete(f"{BASE}/1", headers=operator_headers).status_code == 403


# ---------------- 创建 ----------------


def test_create_rule_returns_full_dto(client, admin_headers):
    r = client.post(BASE, json=_payload(), headers=admin_headers)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["id"] > 0
    assert data["name"] == "客户 7 天无跟进提醒"
    assert data["entity_type"] == "customer"
    assert data["event_type"] == "stale_follow_up"
    assert data["enabled"] is True
    assert data["priority"] == 0
    assert data["created_at"] and data["updated_at"]
    # 子表回填 id + sort_order 保持
    assert [c["field"] for c in data["conditions"]] == [
        "days_since_created",
        "last_follow_at",
    ]
    assert all(c["id"] > 0 for c in data["conditions"])
    assert all(c["id"] > 0 for c in data["actions"])
    assert data["actions"][0]["action_type"] == "notify_owner"
    assert data["actions"][0]["params"] == {"message": "请及时跟进"}


def test_create_rule_rejects_empty_children(client, admin_headers):
    r = client.post(
        BASE, json=_payload(conditions=[], actions=[]), headers=admin_headers
    )
    assert r.status_code == 422  # min_length=1


def test_create_rule_rejects_bad_field(client, admin_headers):
    body = _payload(conditions=[{"field": "bogus", "operator": "gte", "value": "7"}])
    r = client.post(BASE, json=body, headers=admin_headers)
    assert r.status_code == 422  # field 白名单


def test_create_rule_rejects_bad_operator(client, admin_headers):
    body = _payload(
        conditions=[{"field": "days_since_created", "operator": "like", "value": "7"}]
    )
    r = client.post(BASE, json=body, headers=admin_headers)
    assert r.status_code == 422  # operator Literal


# ---------------- 列表 ----------------


def test_list_rules_empty(client, admin_headers):
    r = client.get(BASE, headers=admin_headers)
    assert r.status_code == 200
    assert r.json() == []


def test_list_rules_returns_all_with_children(client, admin_headers):
    client.post(BASE, json=_payload(name="规则A"), headers=admin_headers)
    client.post(
        BASE,
        json=_payload(
            name="规则B",
            entity_type="lead",
            conditions=[
                {
                    "field": "days_since_created",
                    "operator": "gte",
                    "value": "3",
                    "sort_order": 0,
                }
            ],
        ),
        headers=admin_headers,
    )
    r = client.get(BASE, headers=admin_headers)
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 2
    by_name = {i["name"]: i for i in items}
    assert len(by_name["规则A"]["conditions"]) == 2
    assert len(by_name["规则A"]["actions"]) == 1
    assert by_name["规则B"]["entity_type"] == "lead"


# ---------------- 更新 ----------------


def test_patch_rule_toggle_enabled(client, admin_headers):
    created = client.post(BASE, json=_payload(), headers=admin_headers).json()
    r = client.patch(
        f"{BASE}/{created['id']}", json={"enabled": False}, headers=admin_headers
    )
    assert r.status_code == 200
    data = r.json()
    assert data["enabled"] is False
    # 未传 conditions/actions → 子表保留
    assert len(data["conditions"]) == 2
    assert len(data["actions"]) == 1


def test_patch_rule_rebuilds_children(client, admin_headers):
    created = client.post(BASE, json=_payload(), headers=admin_headers).json()
    old_cond_ids = {c["id"] for c in created["conditions"]}
    old_action_ids = {a["id"] for a in created["actions"]}
    r = client.patch(
        f"{BASE}/{created['id']}",
        json={
            "name": "改名+换条件",
            "conditions": [
                {
                    "field": "days_since_created",
                    "operator": "lte",
                    "value": "30",
                    "sort_order": 0,
                }
            ],
            "actions": [
                {"action_type": "notify_owner", "params": None, "sort_order": 0}
            ],
        },
        headers=admin_headers,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["name"] == "改名+换条件"
    # 整体重建：旧子表 id 全部换新
    new_cond_ids = {c["id"] for c in data["conditions"]}
    new_action_ids = {a["id"] for a in data["actions"]}
    assert new_cond_ids and old_cond_ids.isdisjoint(new_cond_ids)
    assert old_action_ids.isdisjoint(new_action_ids)
    assert data["conditions"][0]["operator"] == "lte"


def test_patch_rule_not_found(client, admin_headers):
    r = client.patch(f"{BASE}/99999", json={"enabled": False}, headers=admin_headers)
    assert r.status_code == 404


def test_patch_rule_preserves_created_by(client, admin_headers):
    """PATCH 只改业务字段，created_by（原始创建人）不被覆盖。"""
    created = client.post(BASE, json=_payload(), headers=admin_headers).json()
    original = created["created_by"]
    assert original, "创建时应记录 created_by（X-User-Id）"
    r = client.patch(
        f"{BASE}/{created['id']}", json={"name": "改名"}, headers=admin_headers
    )
    assert r.status_code == 200
    assert r.json()["created_by"] == original


# ---------------- 删除 ----------------


def test_delete_rule_cascades_children(client, admin_headers, db_session):
    created = client.post(BASE, json=_payload(), headers=admin_headers).json()
    rule_id = created["id"]
    # 落库确认子表存在
    from app.models.crm import CrmRuleAction, CrmRuleCondition

    assert db_session.query(CrmRuleCondition).filter_by(rule_id=rule_id).count() == 2
    assert db_session.query(CrmRuleAction).filter_by(rule_id=rule_id).count() == 1
    r = client.delete(f"{BASE}/{rule_id}", headers=admin_headers)
    assert r.status_code == 204
    # CASCADE 清掉子表 + 主表
    assert db_session.query(CrmRuleCondition).filter_by(rule_id=rule_id).count() == 0
    assert db_session.query(CrmRuleAction).filter_by(rule_id=rule_id).count() == 0
    assert client.get(BASE, headers=admin_headers).json() == []


def test_delete_rule_not_found(client, admin_headers):
    r = client.delete(f"{BASE}/99999", headers=admin_headers)
    assert r.status_code == 404

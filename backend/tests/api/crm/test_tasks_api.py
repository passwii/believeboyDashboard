"""任务端点集成测试 (BLF-510) — CRUD / 状态流转 / 权限 / 审计 / 关联校验。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def _mk_customer(client, headers, name="客户A"):
    r = client.post("/api/v1/crm/customers", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_lead(client, headers, name="线索A"):
    r = client.post("/api/v1/crm/leads", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def _mk_task(client, headers, title="打电话", **kw):
    payload = {"title": title, **kw}
    r = client.post("/api/v1/crm/tasks", headers=headers, json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def test_tasks_require_auth(client):
    assert client.get("/api/v1/crm/tasks").status_code in (401, 403)
    assert client.post("/api/v1/crm/tasks", json={"title": "x"}).status_code in (
        401,
        403,
    )


def test_create_task_defaults_owner_to_self(client, operator_headers):
    r = client.post(
        "/api/v1/crm/tasks", headers=operator_headers, json={"title": "回访"}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["title"] == "回访"
    assert body["owner_id"] == operator_headers["X-User-Id"]
    assert body["status"] == "pending"
    assert body["priority"] == "medium"
    assert body["type"] == "custom"
    assert body["owner_name"] is not None  # 联查 join 字段


def test_create_task_admin_can_assign_owner(client, admin_headers, operator_headers):
    r = client.post(
        "/api/v1/crm/tasks",
        headers=admin_headers,
        json={"title": "指派", "owner_id": operator_headers["X-User-Id"]},
    )
    assert r.status_code == 201
    assert r.json()["owner_id"] == operator_headers["X-User-Id"]


def test_create_task_non_admin_assign_owner_forbidden(client, operator_headers):
    r = client.post(
        "/api/v1/crm/tasks",
        headers=operator_headers,
        json={"title": "指派", "owner_id": operator_headers["X-User-Id"]},
    )
    assert r.status_code == 403


def test_create_task_both_customer_and_lead_400(client, admin_headers):
    """业务上二选一：同时传 customer_id + lead_id → 400（BLF-511）。"""
    cust = _mk_customer(client, admin_headers)
    lead = _mk_lead(client, admin_headers)
    r = client.post(
        "/api/v1/crm/tasks",
        headers=admin_headers,
        json={"title": "拜访", "customer_id": cust["id"], "lead_id": lead["id"]},
    )
    assert r.status_code == 400, r.text


def test_create_task_with_customer_returns_name(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    r = client.post(
        "/api/v1/crm/tasks",
        headers=admin_headers,
        json={"title": "拜访客户", "customer_id": cust["id"]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["customer_id"] == cust["id"]
    assert body["customer_name"] == "客户A"
    assert body["lead_id"] is None
    assert body["lead_name"] is None


def test_create_task_with_lead_returns_name(client, admin_headers):
    lead = _mk_lead(client, admin_headers)
    r = client.post(
        "/api/v1/crm/tasks",
        headers=admin_headers,
        json={"title": "跟进线索", "lead_id": lead["id"]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["lead_id"] == lead["id"]
    assert body["lead_name"] == "线索A"
    assert body["customer_id"] is None
    assert body["customer_name"] is None


def test_create_task_missing_customer_404(client, admin_headers):
    r = client.post(
        "/api/v1/crm/tasks",
        headers=admin_headers,
        json={"title": "x", "customer_id": 999999},
    )
    assert r.status_code == 404


def test_create_task_missing_lead_404(client, admin_headers):
    r = client.post(
        "/api/v1/crm/tasks",
        headers=admin_headers,
        json={"title": "x", "lead_id": 999999},
    )
    assert r.status_code == 404


def test_list_tasks_scope_mine_vs_all(client, admin_headers, operator_headers):
    # admin 建两个任务分别归 admin/operator；operator 只见自己的
    _mk_task(client, admin_headers, title="管理员的")
    _mk_task(
        client,
        admin_headers,
        title="运营的",
        owner_id=operator_headers["X-User-Id"],
    )
    lst = client.get("/api/v1/crm/tasks?scope=all", headers=operator_headers).json()
    assert lst["total"] == 1  # 非 admin 的 all 降级 mine
    assert lst["items"][0]["title"] == "运营的"
    lst_admin = client.get("/api/v1/crm/tasks?scope=all", headers=admin_headers).json()
    assert lst_admin["total"] == 2


def test_list_tasks_filters_and_sort(client, admin_headers):
    _mk_task(
        client,
        admin_headers,
        title="低优-远",
        priority="low",
        due_date=(datetime.now(timezone.utc) + timedelta(days=5)).isoformat(),
    )
    _mk_task(
        client,
        admin_headers,
        title="高优-近",
        priority="high",
        due_date=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    )
    # 默认排序：due_date asc（近的在前）
    lst = client.get("/api/v1/crm/tasks?scope=all", headers=admin_headers).json()
    assert [i["title"] for i in lst["items"]] == ["高优-近", "低优-远"]
    # 筛选 priority=high
    lst = client.get(
        "/api/v1/crm/tasks?scope=all&priority=high", headers=admin_headers
    ).json()
    assert lst["total"] == 1
    assert lst["items"][0]["title"] == "高优-近"


def test_list_tasks_owner_filter_admin_only(client, admin_headers, operator_headers):
    _mk_task(
        client,
        admin_headers,
        title="运营的",
        owner_id=operator_headers["X-User-Id"],
    )
    # 非 admin 传 owner_id → 403
    r = client.get(
        "/api/v1/crm/tasks?owner_id=" + operator_headers["X-User-Id"],
        headers=operator_headers,
    )
    assert r.status_code == 403
    # admin 可以（scope=all 看全部）
    r = client.get(
        "/api/v1/crm/tasks?scope=all&owner_id=" + operator_headers["X-User-Id"],
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert r.json()["total"] == 1


def test_list_tasks_unknown_filter_field_400(client, admin_headers):
    r = client.get("/api/v1/crm/tasks?sort_by=hacked", headers=admin_headers)
    assert r.status_code == 400


def test_get_task_owner_ok_other_forbidden(
    client, admin_headers, operator_headers, businessdev_headers
):
    # 归 operator 的任务：owner 可见；他人（businessdev）403；admin 可见
    task = _mk_task(
        client,
        admin_headers,
        title="运营的任务",
        owner_id=operator_headers["X-User-Id"],
    )
    r = client.get(f"/api/v1/crm/tasks/{task['id']}", headers=operator_headers)
    assert r.status_code == 200
    r = client.get(f"/api/v1/crm/tasks/{task['id']}", headers=businessdev_headers)
    assert r.status_code == 403  # 非 owner 非 admin
    r = client.get(f"/api/v1/crm/tasks/{task['id']}", headers=admin_headers)
    assert r.status_code == 200


def test_get_task_not_found(client, admin_headers):
    assert (
        client.get("/api/v1/crm/tasks/999999", headers=admin_headers).status_code == 404
    )


def test_update_task_fields(client, admin_headers):
    task = _mk_task(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"title": "新标题", "priority": "high"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "新标题"
    assert body["priority"] == "high"


def test_update_task_owner_non_admin_forbidden(client, admin_headers, operator_headers):
    task = _mk_task(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=operator_headers,
        json={"owner_id": operator_headers["X-User-Id"]},
    )
    assert r.status_code == 403


def test_list_tasks_joins_customer_lead_names(client, admin_headers):
    """列表联查：customer_name / lead_name 批量填充（防 N+1）。"""
    cust = _mk_customer(client, admin_headers, name="客户甲")
    lead = _mk_lead(client, admin_headers, name="线索乙")
    t1 = _mk_task(client, admin_headers, title="拜访甲", customer_id=cust["id"])
    t2 = _mk_task(client, admin_headers, title="跟进乙", lead_id=lead["id"])
    lst = client.get("/api/v1/crm/tasks?scope=all", headers=admin_headers).json()
    by_id = {i["id"]: i for i in lst["items"]}
    assert by_id[t1["id"]]["customer_name"] == "客户甲"
    assert by_id[t1["id"]]["lead_name"] is None
    assert by_id[t2["id"]]["lead_name"] == "线索乙"
    assert by_id[t2["id"]]["customer_name"] is None


def test_get_task_joins_customer_lead_names(client, admin_headers):
    cust = _mk_customer(client, admin_headers, name="客户丙")
    task = _mk_task(client, admin_headers, title="回访丙", customer_id=cust["id"])
    body = client.get(f"/api/v1/crm/tasks/{task['id']}", headers=admin_headers).json()
    assert body["customer_name"] == "客户丙"


def test_update_task_missing_lead_404(client, admin_headers):
    task = _mk_task(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"lead_id": 999999},
    )
    assert r.status_code == 404


def test_update_task_both_customer_and_lead_400(client, admin_headers):
    cust = _mk_customer(client, admin_headers)
    lead = _mk_lead(client, admin_headers)
    task = _mk_task(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"customer_id": cust["id"], "lead_id": lead["id"]},
    )
    assert r.status_code == 400, r.text


def test_update_task_adding_lead_when_customer_linked_400(client, admin_headers):
    """已关联客户的任务再关联线索（合并后二选一被破坏）→ 400。"""
    cust = _mk_customer(client, admin_headers)
    lead = _mk_lead(client, admin_headers)
    task = _mk_task(client, admin_headers, customer_id=cust["id"])
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"lead_id": lead["id"]},
    )
    assert r.status_code == 400, r.text


def test_update_task_switch_customer_to_lead_ok(client, admin_headers):
    """显式清空 customer 后关联 lead（换关联）→ 200，联查字段同步切换。"""
    cust = _mk_customer(client, admin_headers)
    lead = _mk_lead(client, admin_headers, name="线索丁")
    task = _mk_task(client, admin_headers, customer_id=cust["id"])
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"customer_id": None, "lead_id": lead["id"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["customer_id"] is None
    assert body["customer_name"] is None
    assert body["lead_id"] == lead["id"]
    assert body["lead_name"] == "线索丁"


def test_update_task_clear_customer_link_ok(client, admin_headers):
    """仅清空关联（customer_id=null）→ 200，任务保留不关联任何实体。"""
    cust = _mk_customer(client, admin_headers)
    task = _mk_task(client, admin_headers, customer_id=cust["id"])
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"customer_id": None},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["customer_id"] is None
    assert body["customer_name"] is None


def test_update_task_missing_customer_404(client, admin_headers):
    task = _mk_task(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"customer_id": 999999},
    )
    assert r.status_code == 404


def test_complete_task(client, admin_headers):
    task = _mk_task(client, admin_headers)
    r = client.post(f"/api/v1/crm/tasks/{task['id']}/complete", headers=admin_headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "done"
    assert body["completed_at"] is not None


def test_complete_cancelled_task_conflict(client, admin_headers):
    task = _mk_task(client, admin_headers)
    client.post(f"/api/v1/crm/tasks/{task['id']}/cancel", headers=admin_headers)
    r = client.post(f"/api/v1/crm/tasks/{task['id']}/complete", headers=admin_headers)
    assert r.status_code == 409


def test_cancel_task(client, admin_headers):
    task = _mk_task(client, admin_headers)
    r = client.post(f"/api/v1/crm/tasks/{task['id']}/cancel", headers=admin_headers)
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"


def test_status_flow_and_terminal_guard(client, admin_headers):
    task = _mk_task(client, admin_headers)
    r = client.post(
        f"/api/v1/crm/tasks/{task['id']}/status",
        headers=admin_headers,
        json={"status": "in_progress"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "in_progress"
    # 流转到 done 后不可再流转
    client.post(
        f"/api/v1/crm/tasks/{task['id']}/status",
        headers=admin_headers,
        json={"status": "done"},
    )
    r = client.post(
        f"/api/v1/crm/tasks/{task['id']}/status",
        headers=admin_headers,
        json={"status": "pending"},
    )
    assert r.status_code == 409


def test_status_invalid_value_400(client, admin_headers):
    task = _mk_task(client, admin_headers)
    # TaskStatusUpdate Literal 校验拒绝非白名单状态 → 422（服务层另有 400 兜底）
    r = client.post(
        f"/api/v1/crm/tasks/{task['id']}/status",
        headers=admin_headers,
        json={"status": "weird"},
    )
    assert r.status_code == 422


def test_task_actions_write_audit_log(client, admin_headers):
    """所有写端点走 audit_service.record_log，entity_type=task。"""
    task = _mk_task(client, admin_headers)
    client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={"priority": "high"},
    )
    client.post(f"/api/v1/crm/tasks/{task['id']}/complete", headers=admin_headers)

    r = client.get(
        "/api/v1/crm/audit-logs?entity_type=task",
        headers=admin_headers,
    )
    assert r.status_code == 200
    logs = r.json()["items"]
    actions = [log["action"] for log in logs]
    assert "create" in actions
    assert "update" in actions
    assert "complete" in actions
    assert all(log["entity_type"] == "task" for log in logs)


def test_complete_call_task_creates_follow_and_writeback(client, admin_headers):
    """§3.3 联动端到端：complete 带 next_follow_at + note → follow 生成 + 客户回写 + 审计。"""
    cust = _mk_customer(client, admin_headers)
    task = _mk_task(
        client, admin_headers, type="call", customer_id=cust["id"], title="电话沟通"
    )
    r = client.post(
        f"/api/v1/crm/tasks/{task['id']}/complete",
        headers=admin_headers,
        json={"next_follow_at": "2026-09-01T10:00:00Z", "note": "确认了方案"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "done"
    assert body["completed_at"] is not None

    # 自动生成 follow：call→phone，content=标题：备注
    lst = client.get(
        "/api/v1/crm/follows",
        params={"entity_type": "customer", "entity_id": cust["id"]},
        headers=admin_headers,
    )
    assert lst.status_code == 200
    follows = lst.json()
    assert len(follows) == 1
    assert follows[0]["type"] == "phone"
    assert follows[0]["content"] == "电话沟通：确认了方案"
    assert follows[0]["next_follow_at"] is not None

    # 客户 last_follow_at/next_follow_at 回写
    detail = client.get(
        f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers
    ).json()
    assert detail["last_follow_at"] is not None
    assert detail["next_follow_at"] is not None

    # 审计 action=complete
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "task", "entity_id": task["id"]},
        headers=admin_headers,
    ).json()["items"]
    assert any(log["action"] == "complete" for log in logs)


def test_complete_custom_task_no_follow_api(client, admin_headers):
    """custom 类完成不联动生成 follow。"""
    cust = _mk_customer(client, admin_headers)
    task = _mk_task(client, admin_headers, type="custom", customer_id=cust["id"])
    r = client.post(f"/api/v1/crm/tasks/{task['id']}/complete", headers=admin_headers)
    assert r.status_code == 200, r.text
    lst = client.get(
        "/api/v1/crm/follows",
        params={"entity_type": "customer", "entity_id": cust["id"]},
        headers=admin_headers,
    )
    assert lst.json() == []


def test_complete_task_clears_next_follow_at(client, admin_headers):
    """未填「下次跟进时间」→ 清空实体 next_follow_at（与 create_follow 语义一致）。"""
    cust = _mk_customer(client, admin_headers)
    r = client.post(
        "/api/v1/crm/follows",
        headers=admin_headers,
        json={
            "entity_type": "customer",
            "entity_id": cust["id"],
            "type": "note",
            "content": "先约下次",
            "next_follow_at": "2026-09-01T10:00:00Z",
        },
    )
    assert r.status_code == 201, r.text
    detail = client.get(
        f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers
    ).json()
    assert detail["next_follow_at"] is not None

    task = _mk_task(client, admin_headers, type="call", customer_id=cust["id"])
    r = client.post(f"/api/v1/crm/tasks/{task['id']}/complete", headers=admin_headers)
    assert r.status_code == 200, r.text
    detail2 = client.get(
        f"/api/v1/crm/customers/{cust['id']}", headers=admin_headers
    ).json()
    assert detail2["last_follow_at"] is not None
    assert detail2["next_follow_at"] is None


def test_task_update_summary_covers_priority_due_owner(
    client, admin_headers, operator_headers
):
    """审计 update 摘要覆盖 优先级/截止/负责人 变更（summarize_update 模式）。"""
    task = _mk_task(client, admin_headers)
    r = client.patch(
        f"/api/v1/crm/tasks/{task['id']}",
        headers=admin_headers,
        json={
            "priority": "urgent",
            "due_date": "2026-09-10T00:00:00Z",
            "owner_id": operator_headers["X-User-Id"],
        },
    )
    assert r.status_code == 200, r.text
    logs = client.get(
        "/api/v1/crm/audit-logs",
        params={"entity_type": "task", "entity_id": task["id"]},
        headers=admin_headers,
    ).json()["items"]
    update_log = next((l for l in logs if l["action"] == "update"), None)
    assert update_log is not None
    assert "优先级" in update_log["summary"]
    assert "截止" in update_log["summary"]
    assert "负责人" in update_log["summary"]


def test_task_audit_in_drawer_scope(client, admin_headers):
    """P5-9 多值审计过滤兼容 task 实体（客户抽屉同查客户+任务）。"""
    task = _mk_task(client, admin_headers)
    r = client.get(
        "/api/v1/crm/audit-logs",
        params={
            "entity_types": ["task", "customer"],
            "entity_ids": [task["id"]],
        },
        headers=admin_headers,
    )
    assert r.status_code == 200
    assert any(
        log["entity_type"] == "task" and log["entity_id"] == task["id"]
        for log in r.json()["items"]
    )

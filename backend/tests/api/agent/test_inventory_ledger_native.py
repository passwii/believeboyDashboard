"""Agent 库存台账域原生路由测试（BLF-582 原生化：非 ad 域之一）。

覆盖（对齐 BLF-580 test_ad_campaigns.py 模板）：
1. parity：agent 通道 data == ``app.services.inventory.ledger`` 直调
   （空台账数据，months/snapshot/events/trend/batches 代表路由；响应模型
   model_dump 全等）。
2. 鉴权/壳：401 / 404 项目不存在 / 403 project_scope / 403 business_scope
   不含 inventory_ledger；integrity 非整月窗口 → 400 VALIDATION_FAILED 壳。
3. 路由面：10 条原生路由注册；external_mirror 已退役删除（BLF-583），镜像
   路径整体移除；external/inventory_ledger.py 已删除。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import Project


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


@pytest.fixture
def ledger_env(make_api_key):
    """临时项目 + 全放行 key（无台账数据），测试后清理。"""
    agent_id = f"blf582il-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf582-ledger-{suffix}"

    db = SessionLocal()
    try:
        project = Project(
            project_name=project_name,
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "key": key,
        "headers": _headers(key, agent_id),
    }

    db = SessionLocal()
    try:
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调（空数据）
# ---------------------------------------------------------------------------


def test_inventory_ledger_months_parity(client, ledger_env):
    from app.schemas.inventory_ledger import MonthsResponse
    from app.services.inventory.ledger import get_available_months

    pid = ledger_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/inventory-ledger/months",
        headers=ledger_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    db = SessionLocal()
    try:
        months = get_available_months(db, pid)
        expected = MonthsResponse(project_id=pid, months=months).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected
    assert agent_data["months"] == []


def test_inventory_ledger_snapshot_parity(client, ledger_env):
    """snapshot（空数据）：report_month / sku_count=0 / integrity PENDING 语义。"""
    pid = ledger_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/inventory-ledger/snapshot?period=last_month",
        headers=ledger_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]
    assert agent_data["sku_count"] == 0
    assert agent_data["total_qty"] == 0
    assert agent_data["skus"] == []
    assert agent_data["disposition_summary"] == []


def test_inventory_ledger_trend_parity(client, ledger_env):
    from app.schemas.inventory_ledger import TrendResponse
    from app.services.inventory.ledger import get_trend

    pid = ledger_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/inventory-ledger/trend?months=6",
        headers=ledger_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    db = SessionLocal()
    try:
        items = get_trend(db, pid, months=6)
        expected = TrendResponse(project_id=pid, months=items).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected


def test_inventory_ledger_batches_parity(client, ledger_env):
    from app.schemas.inventory_ledger import IngestBatchInfo, IngestBatchesResponse
    from app.services.inventory.ledger import list_ingest_batches

    pid = ledger_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/inventory-ledger/batches?limit=50",
        headers=ledger_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    db = SessionLocal()
    try:
        batches = list_ingest_batches(db, pid, limit=50)
        expected = IngestBatchesResponse(
            project_id=pid,
            batches=[IngestBatchInfo.model_validate(b) for b in batches],
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected
    assert agent_data["batches"] == []


# ---------------------------------------------------------------------------
# 2. 鉴权 / 壳：401 / 404 / 403 / 400
# ---------------------------------------------------------------------------


def test_inventory_ledger_401_without_credentials(client, ledger_env):
    resp = client.get(
        f"/api/v1/agent/projects/{ledger_env['project_id']}/inventory-ledger/months"
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "AGENT_AUTH_FAILED"


def test_inventory_ledger_404_project_not_found(client, ledger_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/inventory-ledger/months",
        headers=ledger_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_inventory_ledger_403_project_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="blf582il-scoped", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/inventory-ledger/months",
        headers=_headers(key, "blf582il-scoped"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_inventory_ledger_403_business_scope_missing(client, ledger_env, make_api_key):
    """business_scope 不含 inventory_ledger → 403。"""
    key = make_api_key(
        agent_id="blf582il-biz",
        project_scope="*",
        business_scope="inventory",
    )
    resp = client.get(
        f"/api/v1/agent/projects/{ledger_env['project_id']}/inventory-ledger/months",
        headers=_headers(key, "blf582il-biz"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_inventory_ledger_integrity_partial_period_400(client, ledger_env):
    """integrity 非整月窗口 → 400 VALIDATION_FAILED 壳（与原 external 一致）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{ledger_env['project_id']}"
        "/inventory-ledger/integrity?period=7d",
        headers=ledger_env["headers"],
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# 3. 路由面 / 镜像排除（模板断言）
# ---------------------------------------------------------------------------

_INVENTORY_LEDGER_RELS = [
    "/projects/{project_id}/inventory-ledger/months",
    "/projects/{project_id}/inventory-ledger/snapshot",
    "/projects/{project_id}/inventory-ledger/events",
    "/projects/{project_id}/inventory-ledger/receipt-clusters",
    "/projects/{project_id}/inventory-ledger/integrity",
    "/projects/{project_id}/inventory-ledger/trend",
    "/projects/{project_id}/inventory-ledger/detail",
    "/projects/{project_id}/inventory-ledger/summary",
    "/projects/{project_id}/inventory-ledger/batches",
    "/projects/{project_id}/inventory-ledger/consistency",
]


def test_inventory_ledger_native_routes_registered_and_mirror_removed():
    from app.api.v1.endpoints.agent.inventory_ledger import inventory_ledger_router

    native_paths = {r.path for r in inventory_ledger_router.routes}
    assert native_paths == set(_INVENTORY_LEDGER_RELS), native_paths

    # BLF-583：external_mirror 已退役删除，镜像路由整体移除，无双挂可能。
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.agent.external_mirror  # noqa: F401


def test_external_inventory_ledger_module_deleted():
    """external/inventory_ledger.py 端点模块已删除：import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.inventory_ledger  # noqa: F401

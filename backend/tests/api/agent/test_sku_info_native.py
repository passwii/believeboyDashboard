"""Agent SKU Info 主数据域原生读路由测试（BLF-582；设计对齐 BLF-579 spec §4 R1）。

覆盖（对齐 BLF-580 test_ad_campaigns.py 模板）：
1. parity：agent 通道 data == ``list_sku_records`` 直调 + 同构序列化
   （BLF-579 spec §4 R1：items/page/page_size/total/has_next；``is_active``
   默认 true；country 归一）。
2. 鉴权/壳：401 / 404 项目不存在 / 403 project_scope / 403 business_scope
   不含 sku_info。
3. 路由面/镜像排除：原生路由注册；external_mirror 无 sku-info 镜像路径；
   _EXCLUDED_EXTERNAL_PATHS 含 sku-info；external/sku_info.py 已删除。
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.sku_info import SkuRecord


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


@pytest.fixture
def sku_info_env(make_api_key):
    """临时项目 + 全放行 key + 2 个上架 SKU + 1 个下架 SKU，测试后清理。"""
    agent_id = f"blf582s-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf582-skuinfo-{suffix}"

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

        def _sku(sku: str, *, active: bool) -> SkuRecord:
            return SkuRecord(
                project_id=project.id,
                project_name=project_name,
                sku=sku,
                asin=f"ASIN-{sku}",
                country="US",
                fob_unit_cost=10,
                first_leg_cost_rmb=1,
                package_length_cm=10,
                package_width_cm=10,
                package_height_cm=10,
                weight_kg=0.5,
                carton_length_cm=20,
                carton_width_cm=20,
                carton_height_cm=20,
                carton_weight_kg=5,
                units_per_carton=10,
                currency="USD",
                sort_order=0,
                is_active=active,
            )

        db.add(_sku("SKU-A", active=True))
        db.add(_sku("SKU-B", active=True))
        db.add(_sku("SKU-C", active=False))
        db.commit()
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
        db.execute(delete(SkuRecord).where(SkuRecord.project_id == project_id))
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


def _expected_items(db, project_id: int, **kwargs) -> list[dict]:
    """与 agent 原生路由同参数调 list_sku_records + 同构序列化（parity 期望）。"""
    from app.services.data.sku_info import list_sku_records

    rows, total, has_next = list_sku_records(
        db,
        None,
        kwargs.get("sku"),
        kwargs.get("asin"),
        kwargs.get("country"),
        kwargs.get("is_active", True),
        kwargs.get("page", 1),
        kwargs.get("page_size", 200),
        include_total=kwargs.get("include_total", False),
        managed_project_ids=[project_id],
    )
    return rows, total, has_next


def _serialize_like(row) -> dict:
    """同构行（镜像 agent/sku_info._serialize_sku_record 的公共字段子集）。"""
    return {
        "id": int(row.id),
        "project_name": str(row.project_name),
        "sku": str(row.sku),
        "asin": str(row.asin),
        "country": str(row.country),
        "is_active": bool(row.is_active),
    }


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调
# ---------------------------------------------------------------------------


def test_sku_info_list_parity(client, sku_info_env):
    """agent 通道 data == list_sku_records 直调（is_active 默认 true）。"""
    pid = sku_info_env["project_id"]

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/sku-info?include_total=true",
        headers=sku_info_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    agent_data = body["data"]

    db = SessionLocal()
    try:
        rows, total, has_next = _expected_items(db, pid, include_total=True)
    finally:
        db.close()

    assert agent_data["page"] == 1
    assert agent_data["page_size"] == 200
    assert agent_data["total"] == 2  # 只有 2 个上架 SKU（默认 is_active=true）
    assert agent_data["has_next"] is False
    assert len(agent_data["items"]) == 2
    skus = {item["sku"] for item in agent_data["items"]}
    assert skus == {"SKU-A", "SKU-B"}  # SKU-C 下架默认不返回

    # items 形状与 service 直调行同构（公共字段子集一致）
    assert [item["sku"] for item in agent_data["items"]] == [
        _serialize_like(r)["sku"] for r in rows
    ]
    assert all(item["is_active"] is True for item in agent_data["items"])


def test_sku_info_is_active_false_explicit(client, sku_info_env):
    """``is_active=false`` 显式可查下架 SKU。"""
    pid = sku_info_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/sku-info?is_active=false",
        headers=sku_info_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]["items"]
    assert [item["sku"] for item in items] == ["SKU-C"]


def test_sku_info_country_and_sku_filter(client, sku_info_env):
    """``country=`` + ``sku=``（ilike 模糊）过滤。"""
    pid = sku_info_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/sku-info?country=US&sku=SKU-A",
        headers=sku_info_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]["items"]
    assert [item["sku"] for item in items] == ["SKU-A"]


# ---------------------------------------------------------------------------
# 2. 鉴权 / 壳：401 / 404 / 403
# ---------------------------------------------------------------------------


def test_sku_info_401_without_credentials(client, sku_info_env):
    resp = client.get(f"/api/v1/agent/projects/{sku_info_env['project_id']}/sku-info")
    assert resp.status_code == 401
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_AUTH_FAILED"


def test_sku_info_404_project_not_found(client, sku_info_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/sku-info",
        headers=sku_info_env["headers"],
    )
    assert resp.status_code == 404
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_sku_info_403_project_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="blf582-sku-scoped", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/sku-info",
        headers=_headers(key, "blf582-sku-scoped"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_sku_info_403_business_scope_missing(client, sku_info_env, make_api_key):
    """business_scope 不含 sku_info → 403（BLF-579 spec §3 D2 门禁收口）。"""
    key = make_api_key(
        agent_id="blf582-sku-biz",
        project_scope="*",
        business_scope="shipments",
    )
    resp = client.get(
        f"/api/v1/agent/projects/{sku_info_env['project_id']}/sku-info",
        headers=_headers(key, "blf582-sku-biz"),
    )
    assert resp.status_code == 403
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


# ---------------------------------------------------------------------------
# 3. 路由面 / 镜像排除（模板断言）
# ---------------------------------------------------------------------------


def test_sku_info_native_routes_registered_and_mirror_excluded():
    from app.api.v1.endpoints.agent.external_mirror import (
        _EXCLUDED_EXTERNAL_PATHS,
        external_mirror_router,
    )
    from app.api.v1.endpoints.agent.sku_info import sku_info_router

    native_paths = {r.path for r in sku_info_router.routes}
    assert "/projects/{project_id}/sku-info" in native_paths

    mirror_paths = {r.path for r in external_mirror_router.routes}
    assert "/projects/{project_id}/sku-info" not in mirror_paths, (
        "镜像仍含 sku-info（双挂）"
    )

    assert "/external/projects/{project_id}/sku-info" in _EXCLUDED_EXTERNAL_PATHS, (
        "排除集缺 sku-info"
    )


def test_external_sku_info_module_deleted():
    """external/sku_info.py 端点模块已删除：import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.sku_info  # noqa: F401

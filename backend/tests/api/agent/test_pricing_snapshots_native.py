"""Agent 定价快照原生路由测试（BLF-582 原生化：非 ad 域之一）。

覆盖（对齐 BLF-580 test_ad_campaigns.py 模板）：
1. parity：成功路径（造 shop_calculation 行 + ``create_snapshot``）agent 通道
   data == ``find_pricing_snapshot_as_of`` 直调；无快照 → 404 壳
   （service 返回 (None, []) ↔ agent 404，parity 锁定）。
2. 鉴权/壳：401 / 404 项目不存在 / 403 project_scope / 403 business_scope
   不含 shop_calculations；``as_of`` 非法 → 400 VALIDATION_FAILED 壳。
3. 路由面/镜像排除：1 条原生路由注册；external_mirror 无 pricing-snapshots
   镜像路径；_EXCLUDED_EXTERNAL_PATHS 含之；external/pricing_calculation_
   snapshots.py 已删除。
"""

from __future__ import annotations

import uuid
from datetime import date, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.db.session import SessionLocal
from app.main import app
from app.models import Project
from app.models.shop_calculation import ShopCalculation
from app.schemas.shop_calculation import ShopCalculationCreateRequest
from app.services import shop_calculation_service


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict, agent_id: str | None = None) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id or key["agent_id"],
    }


def _calc_payload(
    project_id: int, project_name: str, *, sku: str
) -> ShopCalculationCreateRequest:
    """字段齐全的最小有效核算请求（对齐 test_shop_calculation_append_only）。"""
    return ShopCalculationCreateRequest(
        project_id=project_id,
        project_name=project_name,
        sku=sku,
        asin=f"B0{sku}ASIN",
        country="US",
        accounting_type="profit_calc",
        package_length_cm=10.0,
        package_width_cm=8.0,
        package_height_cm=5.0,
        weight_kg=0.5,
        fob_product_cost_rmb=20.0,
        first_leg_cost_rmb=5.0,
        ddp_cost_rmb=30.0,
        ddp_cost_usd=4.2,
        sale_price_usd=19.99,
        advertising_rate=0.12,
        return_loss_rate=0.04,
        storage_months=1.0,
        inbound_placement_mode="single_destination",
        usd_to_rmb_rate=7.2,
        usd_to_rmb_rate_source="test",
        size_tier="standard",
        size_tier_label="标准尺寸",
        price_band="15_25",
        price_band_label="$15-25",
        longest_side_in=4.0,
        middle_side_in=3.0,
        shortest_side_in=2.0,
        length_plus_girth_in=14.0,
        volume_cubic_in=24.0,
        volume_cubic_ft=0.014,
        product_weight_lb=1.0,
        product_weight_oz=16.0,
        dimensional_weight_lb=0.8,
        chargeable_weight_lb=1.0,
        chargeable_weight_oz=16.0,
        chargeable_weight_rule="actual",
        fulfillment_fee_rule_label="rule",
        inbound_config_fee_rule_label="rule",
        storage_fee_rule_label="rule",
        referral_fee_usd=3.0,
        advertising_fee_usd=2.4,
        return_loss_usd=0.8,
        fba_fulfillment_fee_usd=3.5,
        inbound_config_fee_usd=0.3,
        storage_fee_usd=0.2,
        total_fee_usd=10.2,
        payout_usd=15.0,
        profit_usd=4.8,
        profit_rate=0.24,
    )


@pytest.fixture
def pricing_env(make_api_key):
    """临时项目 + 全放行 key + 1 个 shop_calculation 行 + 1 个定价快照。

    快照经 ``pricing_calculation_snapshot_service.create_snapshot`` 落库
    （与内部端点同路径），测试后清理 ShopCalculation / Snapshot / Project。
    """
    from app.models.pricing_calculation_snapshot import (
        PricingCalculationSnapshot,
        PricingCalculationSnapshotItem,
    )
    from app.services import pricing_calculation_snapshot_service

    agent_id = f"blf582ps-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf582-pricing-{suffix}"

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

        payload = _calc_payload(project.id, project_name, sku="PSKU-1")
        shop_calculation_service.append_calculation(db, payload, operator=None)
        db.commit()

        snapshot = pricing_calculation_snapshot_service.create_snapshot(
            db,
            project_id=project.id,
            country="US",
            name="test-freeze",
            description=None,
            operator="pytest",
        )
        db.commit()
        snapshot_id = snapshot.id
        project_id = project.id
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "agent_id": agent_id,
        "key": key,
        "headers": _headers(key, agent_id),
        "snapshot_id": snapshot_id,
    }

    db = SessionLocal()
    try:
        db.execute(
            delete(PricingCalculationSnapshotItem).where(
                PricingCalculationSnapshotItem.snapshot_id == snapshot_id
            )
        )
        db.execute(
            delete(PricingCalculationSnapshot).where(
                PricingCalculationSnapshot.id == snapshot_id
            )
        )
        db.execute(
            delete(ShopCalculation).where(ShopCalculation.project_id == project_id)
        )
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 1. parity —— agent 通道 == service 直调（成功 + 无快照 404）
# ---------------------------------------------------------------------------


def test_pricing_snapshots_parity_with_snapshot(client, pricing_env):
    """有快照：agent 通道 data == find_pricing_snapshot_as_of 直调。"""
    from app.schemas.external.shop_calculation import (
        ShopCalculationSnapshotsResponse,
    )
    from app.services.external import _pricing_calculation_snapshot as svc

    pid = pricing_env["project_id"]
    resp = client.get(
        f"/api/v1/agent/projects/{pid}/pricing-snapshots?country=US",
        headers=pricing_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    agent_data = resp.json()["data"]

    db = SessionLocal()
    try:
        _snapshot_id, rows = svc.find_pricing_snapshot_as_of(
            db, project_id=pid, country="US", as_of=None
        )
        expected = ShopCalculationSnapshotsResponse(
            project_id=pid,
            from_date=None,
            to_date=None,
            sku=None,
            country="US",
            total=len(rows),
            data=rows,
        ).model_dump(mode="json")
    finally:
        db.close()

    assert agent_data == expected
    assert agent_data["total"] == 1
    assert agent_data["data"][0]["sku"] == "PSKU-1"


def test_pricing_snapshots_as_of_filter(client, pricing_env):
    """``as_of`` 在未来日期命中；在过去日期（早于 snapshot_date）→ 404。"""
    pid = pricing_env["project_id"]
    future = (date.today() + timedelta(days=30)).isoformat()
    past = (date.today() - timedelta(days=30)).isoformat()

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/pricing-snapshots?country=US&as_of={future}",
        headers=pricing_env["headers"],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["total"] == 1

    resp = client.get(
        f"/api/v1/agent/projects/{pid}/pricing-snapshots?country=US&as_of={past}",
        headers=pricing_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_pricing_snapshots_no_snapshot_404(client, make_api_key):
    """无快照项目：agent 404 壳（service 返回 (None, []) 的 parity 语义）。"""
    from app.services.external import _pricing_calculation_snapshot as svc

    agent_id = f"blf582psn-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, project_scope="*")
    suffix = uuid.uuid4().hex[:8]
    project_name = f"blf582-pricing-empty-{suffix}"

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
        pid = project.id
        snapshot_id, rows = svc.find_pricing_snapshot_as_of(
            db, project_id=pid, country="US", as_of=None
        )
        assert snapshot_id is None and rows == []
    finally:
        db.close()

    try:
        resp = client.get(
            f"/api/v1/agent/projects/{pid}/pricing-snapshots?country=US",
            headers=_headers(key, agent_id),
        )
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
    finally:
        db = SessionLocal()
        try:
            obj = db.get(Project, pid)
            if obj is not None:
                db.delete(obj)
            db.commit()
        finally:
            db.close()


# ---------------------------------------------------------------------------
# 2. 鉴权 / 壳：401 / 404 / 403 / 400
# ---------------------------------------------------------------------------


def test_pricing_snapshots_401_without_credentials(client, pricing_env):
    resp = client.get(
        f"/api/v1/agent/projects/{pricing_env['project_id']}/pricing-snapshots"
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "AGENT_AUTH_FAILED"


def test_pricing_snapshots_404_project_not_found(client, pricing_env):
    resp = client.get(
        "/api/v1/agent/projects/99999999/pricing-snapshots",
        headers=pricing_env["headers"],
    )
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_pricing_snapshots_403_project_out_of_scope(client, make_api_key):
    key = make_api_key(agent_id="blf582ps-scoped", project_scope="1")
    resp = client.get(
        "/api/v1/agent/projects/99999999/pricing-snapshots",
        headers=_headers(key, "blf582ps-scoped"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_pricing_snapshots_403_business_scope_missing(
    client, pricing_env, make_api_key
):
    """business_scope 不含 shop_calculations → 403（定价快照归店铺测算域）。"""
    key = make_api_key(
        agent_id="blf582ps-biz",
        project_scope="*",
        business_scope="shipments",
    )
    resp = client.get(
        f"/api/v1/agent/projects/{pricing_env['project_id']}/pricing-snapshots",
        headers=_headers(key, "blf582ps-biz"),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_pricing_snapshots_invalid_as_of_400(client, pricing_env):
    """``as_of`` 非法 → 400 VALIDATION_FAILED 壳（与原 external 一致）。"""
    resp = client.get(
        f"/api/v1/agent/projects/{pricing_env['project_id']}"
        "/pricing-snapshots?as_of=not-a-date",
        headers=pricing_env["headers"],
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# 3. 路由面（模板断言：原生路由注册 + external_mirror 已删）
# ---------------------------------------------------------------------------


def test_pricing_snapshots_native_route_registered_and_mirror_removed():
    from app.api.v1.endpoints.agent.pricing_calculation_snapshots import (
        pricing_snapshots_router,
    )

    native_paths = {r.path for r in pricing_snapshots_router.routes}
    assert "/projects/{project_id}/pricing-snapshots" in native_paths

    # BLF-583：external_mirror 已退役删除，镜像路由整体移除，无双挂可能。
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.agent.external_mirror  # noqa: F401


def test_external_pricing_calculation_snapshots_module_deleted():
    """external/pricing_calculation_snapshots.py 端点模块已删除：import 应失败。"""
    with pytest.raises(ModuleNotFoundError):
        import app.api.v1.endpoints.external.pricing_calculation_snapshots  # noqa: F401

"""GET /api/v1/pricing-calculation/runs keyword 搜索测试

注：本测试需要 backend/.env 配置数据库连接才能跑（执行前需先 alembic upgrade head）。
无真 DB 环境下可运行 `pytest tests/api/test_pricing_calculation_runs.py --collect-only`
验证测试可被收集。
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Iterable

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.main import app
from app.models.pricing_calculation import PricingCalculationRun


def _unique_marker(prefix: str) -> str:
    """生成 UUID 后缀的 marker，避免共享 DB 上多次跑测试时数据互相串扰"""
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


@pytest.fixture
def client():
    return TestClient(app)


def _admin_headers() -> dict[str, str]:
    """管理员身份请求头（绕过非 admin 强制 created_by 隔离）"""
    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Operator": "tester",
        "X-Is-Admin": "true",
    }


def _make_run(
    db,
    *,
    product_name: str,
    created_by: str = "tester",
    country: str = "US",
    project_id: int | None = None,
    sku: str | None = None,
) -> PricingCalculationRun:
    """插入一条最小可用的 PricingCalculationRun 记录（不调用任何 service 计算逻辑）"""
    row = PricingCalculationRun(
        country=country,
        product_name=product_name,
        package_length_cm=Decimal("10"),
        package_width_cm=Decimal("10"),
        package_height_cm=Decimal("10"),
        weight_kg=Decimal("0.5"),
        fob_product_cost_rmb=Decimal("10"),
        first_leg_cost_rmb=Decimal("5"),
        ddp_cost_rmb=Decimal("15"),
        ddp_cost_usd=Decimal("2"),
        sale_price_usd=Decimal("20"),
        usd_to_rmb_rate=Decimal("7.25"),
        usd_to_rmb_rate_source="test",
        size_tier="standard",
        size_tier_label="标准",
        price_band="standard",
        price_band_label="标准",
        longest_side_in=Decimal("4"),
        middle_side_in=Decimal("4"),
        shortest_side_in=Decimal("4"),
        length_plus_girth_in=Decimal("20"),
        volume_cubic_in=Decimal("64"),
        volume_cubic_ft=Decimal("0.037"),
        product_weight_lb=Decimal("1.1"),
        product_weight_oz=Decimal("17.6"),
        dimensional_weight_lb=Decimal("1.5"),
        chargeable_weight_lb=Decimal("1.5"),
        chargeable_weight_oz=Decimal("24"),
        chargeable_weight_rule="actual",
        fulfillment_fee_rule_label="std",
        inbound_config_fee_rule_label="std",
        storage_fee_rule_label="std",
        referral_fee_usd=Decimal("3"),
        advertising_fee_usd=Decimal("2"),
        return_loss_usd=Decimal("0.8"),
        fba_fulfillment_fee_usd=Decimal("5"),
        inbound_config_fee_usd=Decimal("0"),
        storage_fee_usd=Decimal("0"),
        total_fee_usd=Decimal("10.8"),
        payout_usd=Decimal("9.2"),
        profit_usd=Decimal("2"),
        profit_rate=Decimal("0.10"),
        created_by=created_by,
        project_id=project_id,
        sku=sku,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _list_product_names(response_json: dict) -> list[str]:
    return [item["product_name"] for item in response_json["items"]]


def _created_product_names(marker: str) -> list[str]:
    return [f"{marker}-A", f"{marker}-B", f"{marker}-C"]


def test_keyword_search_by_product_name_ilike(client):
    """keyword 命中 product_name（大小写不敏感的 ilike 模糊匹配）

    注意：项目使用共享 dev/QA Postgres，断言采用"新增数据是否被命中 + 互斥项不命中"，
    不去断言 total 绝对值（避免历史数据干扰）。
    """
    marker = _unique_marker("KWSRCHPROD")
    db = SessionLocal()
    try:
        for name in _created_product_names(marker):
            _make_run(db, product_name=name)
    finally:
        db.close()

    response = client.get(
        "/api/v1/pricing-calculation/runs",
        params={"keyword": f"{marker}-a", "page_size": 100},
        headers=_admin_headers(),
    )
    assert response.status_code == 200
    data = response.json()
    names = _list_product_names(data)
    # 大小写不敏感：-A 命中，-B/-C 不命中
    assert f"{marker}-A" in names
    assert f"{marker}-B" not in names
    assert f"{marker}-C" not in names
    # 至少要能看到本次新增的 1 条
    assert f"{marker}-A" in names
    assert data["total"] >= 1


def test_keyword_search_by_created_by_ilike(client):
    """keyword 命中 created_by（同样走 ilike）"""
    marker = _unique_marker("KWSRCHUSER")
    created_by = f"alice-{uuid.uuid4().hex[:6]}"
    db = SessionLocal()
    try:
        _make_run(db, product_name=f"{marker}-P1", created_by=created_by)
        _make_run(db, product_name=f"{marker}-P2", created_by="bob")
    finally:
        db.close()

    response = client.get(
        "/api/v1/pricing-calculation/runs",
        params={"keyword": created_by, "page_size": 100},
        headers=_admin_headers(),
    )
    assert response.status_code == 200
    data = response.json()
    names = _list_product_names(data)
    assert f"{marker}-P1" in names
    assert f"{marker}-P2" not in names
    assert data["total"] >= 1


def test_keyword_search_no_match_returns_empty_total_zero(client):
    """keyword 不命中时返回空列表 + total=0"""
    marker = _unique_marker("KWSRCHNONE")
    db = SessionLocal()
    try:
        _make_run(db, product_name=f"{marker}-X")
    finally:
        db.close()

    # 用一个绝对不可能出现的中文 + uuid 串
    impossible = f"绝对不存在__{uuid.uuid4().hex}"
    response = client.get(
        "/api/v1/pricing-calculation/runs",
        params={"keyword": impossible, "page_size": 100},
        headers=_admin_headers(),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["items"] == []
    assert data["total"] == 0


def test_keyword_respects_exclude_project_id_default(client):
    """默认 exclude_project_id=true：keyword 命中时仍过滤掉 project_id 非空记录"""
    marker = _unique_marker("KWSRCHEXCL")
    db = SessionLocal()
    try:
        _make_run(db, product_name=f"{marker}-store", project_id=12345)
        _make_run(db, product_name=f"{marker}-new", project_id=None)
    finally:
        db.close()

    response = client.get(
        "/api/v1/pricing-calculation/runs",
        params={"keyword": marker, "page_size": 100},
        headers=_admin_headers(),
    )
    assert response.status_code == 200
    data = response.json()
    names = _list_product_names(data)
    assert f"{marker}-new" in names
    assert f"{marker}-store" not in names
    # 共享 DB 上可能有别的 marker 记录，至少本次新增的 -new 在
    assert data["total"] >= 1

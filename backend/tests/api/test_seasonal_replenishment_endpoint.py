"""季节性补货端点测试。

策略：monkeypatch service 函数和 project_service.ensure_project_access，
绕过 DB。覆盖：
- 正常路径：传 project_id/country/from_date/to_date 拿到 items + summary
- 鉴权：project_service.ensure_project_access 抛 403 时，endpoint 直接返回 403
- 422：to_date < from_date
- 422：日期范围跨度 < 7 天
- compare_year_offset 默认值
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient


@pytest.fixture
def client():
    from app.main import app
    return TestClient(app)


@pytest.fixture
def auth_headers():
    """提供 protected dependency 需要的 X-API-Key。"""
    from app.core.config import get_settings

    settings = get_settings()
    return {
        "X-API-Key": settings.api_key,
        "X-Operator": "tester",
        "X-Is-Admin": "true",
    }


def _patch_service(monkeypatch, *, return_value):
    """monkeypatch list_seasonal_replenishment_analysis 返回预设数据。"""
    monkeypatch.setattr(
        "app.api.v1.endpoints.inventory_replenishment.list_seasonal_replenishment_analysis",
        lambda *args, **kwargs: return_value,
    )
    # ensure_project_access 默认放行
    monkeypatch.setattr(
        "app.api.v1.endpoints.inventory_replenishment.project_service.ensure_project_access",
        lambda *args, **kwargs: None,
    )
    # view_log 当前是 no-op（CLAUDE.md:144），但保留调用站点
    monkeypatch.setattr(
        "app.api.v1.endpoints.inventory_replenishment.append_operation_view_log",
        lambda *args, **kwargs: None,
    )


def _valid_query(**overrides) -> dict:
    base = {
        "project_id": 18,
        "country": "US",
        "from_date": "2025-07-01",
        "to_date": "2025-09-30",
    }
    base.update(overrides)
    return base


class TestSeasonalReplenishmentEndpoint:
    def test_happy_path_returns_items(self, monkeypatch, client, auth_headers):
        _patch_service(
            monkeypatch,
            return_value=(
                [
                    {
                        "project_id": 18,
                        "project_name": "P18",
                        "sku": "SKU-A",
                        "country": "US",
                        "asin": "ASIN001",
                        "product_name": "Test Product",
                        "available_inventory": 100,
                        "in_transit_quantity": 50,
                        "dms_90": 10.0,
                        "dms_30": 8.0,
                        "dms_14": 6.0,
                        "dms_7": 4.0,
                        "dms_90_yoy": None,
                        "dms_30_yoy": None,
                        "dms_14_yoy": None,
                        "dms_7_yoy": None,
                        "base_dms": 8.0,
                        "weighted_dms": 9.6,
                        "sellable_days": 10.42,
                        "sellout_date": "2025-10-10",
                        "sellout_date_with_transit": "2025-10-15",
                        "production_lead_days": 20,
                        "shipping_days": 25,
                        "estimated_replenishment_quantity": 432,
                    }
                ],
                {
                    "sku_count": 1,
                    "out_of_stock_risk_count": 0,
                    "healthy_count": 1,
                    "slow_moving_count": 0,
                    "pending_data_count": 0,
                    "total_available_inventory": 100,
                    "total_in_transit_quantity": 50,
                },
                1,
                False,
            ),
        )

        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(compare_year_offset=0),
            headers=auth_headers,
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["from_date"] == "2025-07-01"
        assert body["to_date"] == "2025-09-30"
        assert body["compare_year_offset"] == 0
        assert body["total"] == 1
        assert len(body["items"]) == 1
        item = body["items"][0]
        assert item["sku"] == "SKU-A"
        assert item["dms_90"] == 10.0
        assert item["weighted_dms"] == 9.6
        # 季节性 schema 没有 risk_status 字段
        assert "risk_status" not in item
        assert "risk_anchor_date" not in item

    def test_default_compare_year_offset_is_zero(self, monkeypatch, client, auth_headers):
        captured = {}

        def capture(**kwargs):
            captured.update(kwargs)
            return (
                [],
                {
                    "sku_count": 0,
                    "out_of_stock_risk_count": 0,
                    "healthy_count": 0,
                    "slow_moving_count": 0,
                    "pending_data_count": 0,
                    "total_available_inventory": 0,
                    "total_in_transit_quantity": 0,
                },
                0,
                False,
            )

        _patch_service(monkeypatch, return_value=capture())
        monkeypatch.setattr(
            "app.api.v1.endpoints.inventory_replenishment.list_seasonal_replenishment_analysis",
            lambda *args, **kwargs: capture(**kwargs),
        )

        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(),
            headers=auth_headers,
        )

        assert resp.status_code == 200
        assert captured["compare_year_offset"] == 0  # 默认值

    def test_compare_year_offset_passed_through(self, monkeypatch, client, auth_headers):
        captured = {}

        def capture(**kwargs):
            captured.update(kwargs)
            return (
                [],
                {
                    "sku_count": 0,
                    "out_of_stock_risk_count": 0,
                    "healthy_count": 0,
                    "slow_moving_count": 0,
                    "pending_data_count": 0,
                    "total_available_inventory": 0,
                    "total_in_transit_quantity": 0,
                },
                0,
                False,
            )

        _patch_service(monkeypatch, return_value=capture())
        monkeypatch.setattr(
            "app.api.v1.endpoints.inventory_replenishment.list_seasonal_replenishment_analysis",
            lambda *args, **kwargs: capture(**kwargs),
        )

        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(compare_year_offset=1),
            headers=auth_headers,
        )
        assert resp.status_code == 200
        assert captured["compare_year_offset"] == 1

    def test_to_date_before_from_date_returns_422(self, monkeypatch, client, auth_headers):
        _patch_service(
            monkeypatch,
            return_value=([], {}, 0, False),
        )

        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(from_date="2025-09-30", to_date="2025-07-01"),
            headers=auth_headers,
        )
        assert resp.status_code == 422
        assert "to_date 必须" in resp.json()["detail"]

    def test_range_too_short_returns_422(self, monkeypatch, client, auth_headers):
        _patch_service(
            monkeypatch,
            return_value=([], {}, 0, False),
        )

        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(from_date="2025-09-25", to_date="2025-09-30"),
            headers=auth_headers,
        )
        assert resp.status_code == 422
        assert "至少 7 天" in resp.json()["detail"]

    def test_project_access_denied_returns_403(self, monkeypatch, client, auth_headers):
        def deny(*args, **kwargs):
            raise HTTPException(status_code=403, detail="无权访问该项目")

        from app.api.v1.endpoints import inventory_replenishment as endpoint_mod

        monkeypatch.setattr(
            endpoint_mod.project_service,
            "ensure_project_access",
            deny,
        )

        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(),
            headers=auth_headers,
        )
        assert resp.status_code == 403

    def test_missing_from_date_returns_422(self, client, auth_headers):
        # FastAPI 会在 Query(...) 上做校验：必填参数缺失 → 422
        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params={"project_id": 18, "country": "US", "to_date": "2025-09-30"},
            headers=auth_headers,
        )
        assert resp.status_code == 422

    def test_missing_to_date_returns_422(self, client, auth_headers):
        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params={"project_id": 18, "country": "US", "from_date": "2025-07-01"},
            headers=auth_headers,
        )
        assert resp.status_code == 422

    def test_invalid_compare_year_offset_returns_422(self, client, auth_headers):
        # compare_year_offset = 5 超出 [0, 2] 范围
        resp = client.get(
            "/api/v1/seasonal-replenishment-analysis",
            params=_valid_query(compare_year_offset=5),
            headers=auth_headers,
        )
        assert resp.status_code == 422
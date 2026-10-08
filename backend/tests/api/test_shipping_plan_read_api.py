from datetime import date
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_shipping_plan_routes_require_api_key():
    response = client.get(
        "/api/v1/shipping-plan/skus",
        params={"project_id": 1, "country": "US"},
    )
    assert response.status_code in (401, 403)


def test_shipping_plan_schemas_export_required_contract_fields():
    from app.schemas.shipping_plan import (
        ForecastPoint,
        ShippingPlanForecastResponse,
        ShippingPlanSkuListResponse,
    )

    sku_fields = ShippingPlanSkuListResponse.model_fields
    forecast_fields = ShippingPlanForecastResponse.model_fields
    assert "valid_forecast_sku_count" in sku_fields
    assert "missing_forecast_sku_count" in sku_fields
    assert "inventory_snapshot_date" in forecast_fields
    assert "data_quality" in forecast_fields
    assert "historical_order_sales" in ForecastPoint.model_fields


def test_single_country_guard_rejects_all_scope():
    import pytest
    from fastapi import HTTPException

    from app.services.shipping_plan.service import _require_single_country

    with pytest.raises(HTTPException) as exc:
        _require_single_country("ALL")
    assert exc.value.status_code == 422


def test_sales_history_uses_contiguous_successful_report_coverage():
    from app.services.shipping_plan.service import _load_historical_sales

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

        def __iter__(self):
            return iter(self.rows)

    class FakeDb:
        def __init__(self):
            self.calls = 0

        def execute(self, _statement):
            self.calls += 1
            if self.calls == 1:
                return FakeResult(
                    [
                        SimpleNamespace(
                            period_start_date=date(2025, 10, 11),
                            period_end_date=date(2025, 10, 11),
                        ),
                        SimpleNamespace(
                            period_start_date=date(2025, 10, 13),
                            period_end_date=date(2025, 10, 13),
                        ),
                    ]
                )
            return FakeResult([(date(2025, 10, 11), 2)])

    result = _load_historical_sales(
        FakeDb(),
        project_id=1,
        country="US",
        sku="SKU",
        forecast_start=date(2026, 10, 11),
        forecast_days=3,
    )

    assert result[date(2026, 10, 11)] == 2
    assert result[date(2026, 10, 12)] is None
    assert result[date(2026, 10, 13)] == 0

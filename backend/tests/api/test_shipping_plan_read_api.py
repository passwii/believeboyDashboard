from datetime import date, datetime, time, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

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


def test_shipment_history_aggregates_skus_by_etd_and_includes_completed_and_in_transit():
    from app.services.shipping_plan.service import get_shipment_history

    class FakeResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class FakeDb:
        def __init__(self):
            self.results = [
                FakeResult(
                    [
                        (1, date(2026, 10, 8), "SHIP-A", 7),
                        (1, date(2026, 10, 8), "SHIP-A", 3),
                        (2, date(2026, 10, 9), "SHIP-B", 4),
                        (3, None, "SHIP-C", 5),
                        (4, date(2026, 10, 10), "SHIP-D", 9),
                    ]
                ),
                FakeResult([]),
                FakeResult([]),
            ]

        def execute(self, _statement):
            return self.results.pop(0)

    result = get_shipment_history(
        FakeDb(),
        project_id=11,
        country="US",
        etd_from=date(2026, 10, 8),
        etd_to=date(2026, 10, 9),
    )

    assert result["months"] == [
        {"month": "2026-10", "shipment_count": 2, "quantity": 14}
    ]
    assert result["missing_etd_shipment_count"] == 1
    assert result["missing_etd_quantity"] == 5


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


def _seed_shipping_history_sales_source(db_session, *, start, end, ingestion_status="success"):
    from app.models import AnalysisSourceFile, Project

    project = Project(project_name=f"BLF1298 history {uuid4()}", sort_order=0)
    db_session.add(project)
    db_session.flush()
    source = AnalysisSourceFile(
        project_id=project.id,
        report_type="sales_report",
        country="US",
        period_start_date=start,
        period_end_date=end,
        version=1,
        is_current=True,
        upload_file_id=f"{uuid4()}.csv",
        upload_file_path="/tmp/shipping-history-sales.csv",
        stored_filename="shipping-history-sales.csv",
        logical_filename="shipping-history-sales.csv",
        storage_key=f"shipping-history/{uuid4()}.csv",
        ingestion_status=ingestion_status,
    )
    db_session.add(source)
    db_session.flush()
    return project, source


def _seed_shipping_history_order(
    db_session,
    *,
    project_id,
    source_id,
    order_id,
    purchased_on,
    quantity,
    status="Pending",
):
    from app.models import AnalysisSalesOrderRow

    db_session.add(
        AnalysisSalesOrderRow(
            source_file_id=source_id,
            source_row_no=1,
            project_id=project_id,
            country="US",
            amazon_order_id=order_id,
            purchase_at_utc=datetime.combine(purchased_on, time(12), tzinfo=timezone.utc),
            purchase_at_pt=datetime.combine(purchased_on, time(4)),
            purchase_date_pt=purchased_on,
            order_status=status,
            sku="SKU-HISTORY",
            quantity=quantity,
            item_price=Decimal("0"),
            shipping_price=Decimal("0"),
            item_tax=Decimal("0"),
            shipping_tax=Decimal("0"),
            is_counted_sales=True,
            raw_row={},
        )
    )
    db_session.flush()


def test_shipment_history_sales_returns_contiguous_months_and_covered_zeroes(db_session):
    from app.services.shipping_plan.service import get_shipment_history

    project, source = _seed_shipping_history_sales_source(
        db_session, start=date(2026, 1, 15), end=date(2026, 3, 15)
    )
    _seed_shipping_history_order(
        db_session,
        project_id=project.id,
        source_id=source.id,
        order_id="BLF1298-FEB",
        purchased_on=date(2026, 2, 12),
        quantity=7,
    )

    result = get_shipment_history(
        db_session,
        project_id=project.id,
        country="US",
        etd_from=date(2026, 1, 15),
        etd_to=date(2026, 3, 15),
    )

    assert result["sales_months"] == [
        {"month": "2026-01", "sales_quantity": 0, "covered": True},
        {"month": "2026-02", "sales_quantity": 7, "covered": True},
        {"month": "2026-03", "sales_quantity": 0, "covered": True},
    ]


def test_shipment_history_sales_marks_month_uncovered_without_successful_report(db_session):
    from app.services.shipping_plan.service import get_shipment_history

    project, source = _seed_shipping_history_sales_source(
        db_session,
        start=date(2026, 2, 1),
        end=date(2026, 2, 28),
        ingestion_status="failed",
    )
    _seed_shipping_history_order(
        db_session,
        project_id=project.id,
        source_id=source.id,
        order_id="BLF1298-FAILED",
        purchased_on=date(2026, 2, 12),
        quantity=9,
    )

    result = get_shipment_history(
        db_session,
        project_id=project.id,
        country="US",
        etd_from=date(2026, 2, 1),
        etd_to=date(2026, 2, 28),
    )

    assert result["sales_months"] == [
        {"month": "2026-02", "sales_quantity": None, "covered": False}
    ]


def test_shipment_history_sales_does_not_report_partially_covered_month(db_session):
    from app.services.shipping_plan.service import get_shipment_history

    project, source = _seed_shipping_history_sales_source(
        db_session, start=date(2026, 2, 1), end=date(2026, 2, 14)
    )
    _seed_shipping_history_order(
        db_session,
        project_id=project.id,
        source_id=source.id,
        order_id="BLF1298-PARTIAL",
        purchased_on=date(2026, 2, 10),
        quantity=4,
    )

    result = get_shipment_history(
        db_session,
        project_id=project.id,
        country="US",
        etd_from=date(2026, 2, 1),
        etd_to=date(2026, 2, 28),
    )

    assert result["sales_months"] == [
        {"month": "2026-02", "sales_quantity": None, "covered": False}
    ]


def test_shipment_history_sales_excludes_cancelled_order_rows(db_session):
    from app.services.shipping_plan.service import get_shipment_history

    project, source = _seed_shipping_history_sales_source(
        db_session, start=date(2026, 2, 1), end=date(2026, 2, 28)
    )
    _seed_shipping_history_order(
        db_session,
        project_id=project.id,
        source_id=source.id,
        order_id="BLF1298-PENDING",
        purchased_on=date(2026, 2, 10),
        quantity=3,
        status="Pending",
    )
    _seed_shipping_history_order(
        db_session,
        project_id=project.id,
        source_id=source.id,
        order_id="BLF1298-CANCELLED",
        purchased_on=date(2026, 2, 11),
        quantity=100,
        status="Cancelled",
    )

    result = get_shipment_history(
        db_session,
        project_id=project.id,
        country="US",
        etd_from=date(2026, 2, 1),
        etd_to=date(2026, 2, 28),
    )

    assert result["sales_months"] == [
        {"month": "2026-02", "sales_quantity": 3, "covered": True}
    ]

from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from app.services.shipping_plan import service
from app.services.shipping_plan.forecast import (
    ShippingPlanBaseline,
    ShippingPlanBaselineItem,
)

AS_OF = date(2026, 10, 9)
START = AS_OF + timedelta(days=1)


def _baseline(*, inventory=2, snapshot=AS_OF - timedelta(days=1), dms=Decimal(3)):
    return ShippingPlanBaseline(
        project_id=10,
        country="US",
        as_of_date=AS_OF,
        items=(
            ShippingPlanBaselineItem(
                sku="SKU-FORECAST",
                asin="ASIN",
                product_name="Product",
                available_inventory=inventory,
                inventory_snapshot_date=snapshot,
                base_dms=dms,
                shipping_days=5,
            ),
        ),
    )


def test_forecast_counts_arrival_on_day_and_separates_confirmed_from_planned():
    shipment_rows = [
        {
            "schedule_id": 1,
            "shipment_no": "TRANSIT",
            "status": "in_transit",
            "eta_date": START,
            "etd_date": None,
            "created_date": None,
            "actual_inbound_date": None,
            "quantity": 4,
        },
        {
            "schedule_id": 2,
            "shipment_no": "DRAFT",
            "status": "draft",
            "eta_date": START,
            "etd_date": None,
            "created_date": None,
            "actual_inbound_date": None,
            "quantity": 5,
        },
    ]
    plan_rows = [
        {"name": "Plan A", "arrival_date": START + timedelta(days=1), "quantity": 4}
    ]
    with (
        patch.object(service, "load_shipping_plan_baseline", return_value=_baseline()),
        patch.object(service, "_get_sku_setting_map", return_value={}),
        patch.object(service, "_get_shipments_by_sku", return_value={"SKU-FORECAST": shipment_rows}),
        patch.object(service, "_get_plan_arrivals", return_value={"SKU-FORECAST": plan_rows}),
        patch.object(service, "_load_historical_sales", return_value={}),
    ):
        result = service.get_shipping_plan_forecast(
            None, project_id=10, country="US", sku="SKU-FORECAST", as_of_date=AS_OF
        )

    first = result["daily_points"][0]
    assert result["forecast_start_date"] == START
    assert result["forecast_end_date"] == START + timedelta(days=179)
    assert first["confirmed_sales"] == Decimal(3)
    assert first["planned_sales"] == Decimal(3)
    assert first["confirmed_closing_inventory"] == Decimal(3)
    assert first["planned_closing_inventory"] == Decimal(8)
    assert result["daily_points"][1]["planned_closing_inventory"] == Decimal(9)
    assert result["demand_source"] == "default"


def test_post_snapshot_completed_inbound_before_start_makes_upper_bound_unknown():
    completed = {
        "schedule_id": 3,
        "shipment_no": "COMPLETED",
        "status": "completed",
        "eta_date": START,
        "etd_date": None,
        "created_date": None,
        "actual_inbound_date": AS_OF,
        "quantity": 40,
    }
    with (
        patch.object(service, "load_shipping_plan_baseline", return_value=_baseline(snapshot=AS_OF - timedelta(days=2))),
        patch.object(service, "_get_sku_setting_map", return_value={}),
        patch.object(service, "_get_shipments_by_sku", return_value={"SKU-FORECAST": [completed]}),
        patch.object(service, "_get_plan_arrivals", return_value={}),
        patch.object(service, "_load_historical_sales", return_value={}),
    ):
        result = service.get_shipping_plan_forecast(
            None, project_id=10, country="US", sku="SKU-FORECAST", as_of_date=AS_OF
        )

    assert "post_snapshot_inbound_before_forecast_start" in result["data_quality"]
    assert result["confirmed_180d_sales_upper_bound"] is None
    assert result["planned_180d_sales_upper_bound"] is None
    assert result["daily_points"][0]["confirmed_sales"] is None


def test_completed_shipment_without_actual_inbound_date_makes_forecast_unknown():
    completed = {
        "schedule_id": 4,
        "shipment_no": "COMPLETED-UNKNOWN-INBOUND",
        "status": "completed",
        "eta_date": None,
        "etd_date": None,
        "created_date": None,
        "actual_inbound_date": None,
        "quantity": 40,
    }
    with (
        patch.object(service, "load_shipping_plan_baseline", return_value=_baseline()),
        patch.object(service, "_get_sku_setting_map", return_value={}),
        patch.object(service, "_get_shipments_by_sku", return_value={"SKU-FORECAST": [completed]}),
        patch.object(service, "_get_plan_arrivals", return_value={}),
        patch.object(service, "_load_historical_sales", return_value={}),
    ):
        result = service.get_shipping_plan_forecast(
            None, project_id=10, country="US", sku="SKU-FORECAST", as_of_date=AS_OF
        )

    assert result["confirmed_180d_sales_upper_bound"] is None
    assert result["planned_180d_sales_upper_bound"] is None
    assert result["daily_points"][0]["confirmed_closing_inventory"] is None
    assert "completed_inbound_unverified" in result["data_quality"]


def test_missing_inventory_or_sales_baseline_does_not_emit_numeric_upper_bound():
    for baseline in (
        _baseline(inventory=None),
        _baseline(dms=None),
    ):
        with (
            patch.object(service, "load_shipping_plan_baseline", return_value=baseline),
            patch.object(service, "_get_sku_setting_map", return_value={}),
            patch.object(service, "_get_shipments_by_sku", return_value={}),
            patch.object(service, "_get_plan_arrivals", return_value={}),
            patch.object(service, "_load_historical_sales", return_value={}),
        ):
            result = service.get_shipping_plan_forecast(
                None, project_id=10, country="US", sku="SKU-FORECAST", as_of_date=AS_OF
            )
        assert result["confirmed_180d_sales_upper_bound"] is None
        assert result["planned_180d_sales_upper_bound"] is None

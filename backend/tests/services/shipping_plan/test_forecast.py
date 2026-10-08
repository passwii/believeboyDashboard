from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.services.shipping_plan.forecast import SupplyArrival, simulate_sku_forecast

START = date(2026, 10, 10)


def test_simulates_arrivals_before_same_day_sales_in_both_scenarios():
    points = simulate_sku_forecast(
        start_date=START,
        horizon_days=3,
        available_inventory=Decimal(2),
        base_dms=Decimal("1.5"),
        growth_factor=Decimal(2),
        confirmed_arrivals=[SupplyArrival(START + timedelta(days=1), 3)],
        planned_only_arrivals=[SupplyArrival(START + timedelta(days=2), 4)],
    )

    assert [point.forecast_date for point in points] == [
        date(2026, 10, 10), date(2026, 10, 11), date(2026, 10, 12)
    ]
    assert [point.demand for point in points] == [Decimal(3)] * 3
    assert [point.confirmed_sales for point in points] == [Decimal(2), Decimal(3), Decimal(0)]
    assert [point.planned_sales for point in points] == [Decimal(2), Decimal(3), Decimal(3)]
    assert points[-1].planned_closing_inventory == Decimal(1)


def test_unmet_demand_does_not_roll_forward_and_decimal_is_not_rounded():
    points = simulate_sku_forecast(
        start_date=START,
        horizon_days=2,
        available_inventory=1,
        base_dms=Decimal("0.333333"),
        growth_factor=Decimal("1.5"),
        confirmed_arrivals=[],
        planned_only_arrivals=[],
    )

    assert points[0].confirmed_sales == Decimal("0.4999995")
    assert points[0].confirmed_closing_inventory == Decimal("0.5000005")
    assert points[1].confirmed_sales == Decimal("0.4999995")
    assert points[1].confirmed_closing_inventory == Decimal("0.0000010")


@pytest.mark.parametrize(
    ("available_inventory", "base_dms"),
    [(None, Decimal(1)), (4, None)],
)
def test_missing_inventory_or_sales_baseline_keeps_forecast_unknown(available_inventory, base_dms):
    points = simulate_sku_forecast(
        start_date=START,
        horizon_days=2,
        available_inventory=available_inventory,
        base_dms=base_dms,
        growth_factor=Decimal(1),
        confirmed_arrivals=[SupplyArrival(START, 8)],
        planned_only_arrivals=[],
    )

    assert all(point.demand is None for point in points)
    assert all(point.confirmed_sales is None for point in points)
    assert all(point.planned_sales is None for point in points)


def test_zero_growth_factor_is_valid_and_same_day_arrivals_count():
    points = simulate_sku_forecast(
        start_date=START,
        horizon_days=1,
        available_inventory=0,
        base_dms=Decimal(9),
        growth_factor=Decimal(0),
        confirmed_arrivals=[SupplyArrival(START, 2)],
        planned_only_arrivals=[SupplyArrival(START, 3)],
    )

    assert points[0].demand == Decimal(0)
    assert points[0].confirmed_sales == Decimal(0)
    assert points[0].planned_sales == Decimal(0)
    assert points[0].planned_closing_inventory == Decimal(5)


def test_rejects_invalid_horizon_and_negative_growth():
    with pytest.raises(ValueError):
        simulate_sku_forecast(
            start_date=START,
            horizon_days=0,
            available_inventory=1,
            base_dms=Decimal(1),
            growth_factor=Decimal(1),
            confirmed_arrivals=[],
            planned_only_arrivals=[],
        )
    with pytest.raises(ValueError):
        simulate_sku_forecast(
            start_date=START,
            horizon_days=1,
            available_inventory=1,
            base_dms=Decimal(1),
            growth_factor=Decimal("-0.1"),
            confirmed_arrivals=[],
            planned_only_arrivals=[],
        )

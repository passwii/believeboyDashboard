from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal


@dataclass(frozen=True)
class SupplyArrival:
    arrival_date: date
    quantity: int

    def __post_init__(self) -> None:
        if self.quantity < 0:
            raise ValueError("arrival quantity cannot be negative")


@dataclass(frozen=True)
class DailyForecastPoint:
    forecast_date: date
    demand: Decimal | None
    confirmed_sales: Decimal | None
    planned_sales: Decimal | None
    confirmed_closing_inventory: Decimal | None
    planned_closing_inventory: Decimal | None


@dataclass(frozen=True)
class ShippingPlanBaselineItem:
    sku: str
    asin: str | None
    product_name: str | None
    available_inventory: int | None
    inventory_snapshot_date: date | None
    base_dms: Decimal | None
    shipping_days: int


@dataclass(frozen=True)
class ShippingPlanBaseline:
    project_id: int
    country: str
    as_of_date: date
    items: tuple[ShippingPlanBaselineItem, ...]


def simulate_sku_forecast(
    *,
    start_date: date,
    horizon_days: int,
    available_inventory: int | None,
    base_dms: Decimal | None,
    growth_factor: Decimal,
    confirmed_arrivals: Sequence[SupplyArrival],
    planned_only_arrivals: Sequence[SupplyArrival],
) -> list[DailyForecastPoint]:
    """Simulate confirmed and planned sales separately from one shared stock baseline."""
    if horizon_days <= 0:
        raise ValueError("horizon_days must be positive")
    if growth_factor < 0:
        raise ValueError("growth_factor must be non-negative")
    if available_inventory is not None and available_inventory < 0:
        raise ValueError("available_inventory must be non-negative")
    if base_dms is not None and base_dms < 0:
        raise ValueError("base_dms must be non-negative")

    if available_inventory is None or base_dms is None:
        return [
            DailyForecastPoint(
                forecast_date=start_date + timedelta(days=offset),
                demand=None,
                confirmed_sales=None,
                planned_sales=None,
                confirmed_closing_inventory=None,
                planned_closing_inventory=None,
            )
            for offset in range(horizon_days)
        ]

    confirmed_by_date: dict[date, int] = {}
    for arrival in confirmed_arrivals:
        confirmed_by_date[arrival.arrival_date] = (
            confirmed_by_date.get(arrival.arrival_date, 0) + arrival.quantity
        )
    planned_by_date: dict[date, int] = {}
    for arrival in planned_only_arrivals:
        planned_by_date[arrival.arrival_date] = (
            planned_by_date.get(arrival.arrival_date, 0) + arrival.quantity
        )

    confirmed_inventory = Decimal(available_inventory)
    planned_inventory = Decimal(available_inventory)
    daily_demand = base_dms * growth_factor
    points: list[DailyForecastPoint] = []
    for offset in range(horizon_days):
        forecast_date = start_date + timedelta(days=offset)
        confirmed_inventory += Decimal(confirmed_by_date.get(forecast_date, 0))
        planned_inventory += Decimal(confirmed_by_date.get(forecast_date, 0))
        planned_inventory += Decimal(planned_by_date.get(forecast_date, 0))
        confirmed_sales = min(daily_demand, confirmed_inventory)
        planned_sales = min(daily_demand, planned_inventory)
        confirmed_inventory -= confirmed_sales
        planned_inventory -= planned_sales
        points.append(
            DailyForecastPoint(
                forecast_date=forecast_date,
                demand=daily_demand,
                confirmed_sales=confirmed_sales,
                planned_sales=planned_sales,
                confirmed_closing_inventory=confirmed_inventory,
                planned_closing_inventory=planned_inventory,
            )
        )
    return points

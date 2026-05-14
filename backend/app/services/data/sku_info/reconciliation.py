from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy.orm import Session

from app.models import SkuRecord
from app.services.data.sku_info.crud import (
    COST_DECIMAL_QUANT,
    _normalize_cost,
    list_sku_records_all,
)


def recalculate_first_leg_costs(
    db: Session,
    *,
    project_name: str,
    unit_price_per_kg_rmb: float,
    sku: str | None = None,
    asin: str | None = None,
    country: str | None = None,
    is_active: bool | None = None,
) -> int:
    unit_price = _normalize_cost(unit_price_per_kg_rmb, "unit_price_per_kg_rmb")
    rows = list_sku_records_all(
        db,
        project_name=project_name,
        sku=sku,
        asin=asin,
        country=country,
        is_active=is_active,
    )
    updated = 0
    for row in rows:
        volume_weight = (
            Decimal(str(row.package_length_cm or 0))
            * Decimal(str(row.package_width_cm or 0))
            * Decimal(str(row.package_height_cm or 0))
        ) / Decimal("6000")
        actual_weight = Decimal(str(row.weight_kg or 0))
        chargeable_weight = max(actual_weight, volume_weight)
        row.first_leg_cost_rmb = (chargeable_weight * unit_price).quantize(
            COST_DECIMAL_QUANT, rounding=ROUND_HALF_UP
        )
        updated += 1
    db.flush()
    return updated

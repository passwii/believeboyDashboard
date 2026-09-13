"""Product cost handling functions."""

from __future__ import annotations

from decimal import Decimal
from typing import TYPE_CHECKING, Any

# BLF-1036: pandas imported lazily — this module loads at API/worker boot via
# app.services.product.analysis; pd is only needed when building the costs DF.
if TYPE_CHECKING:
    import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SkuRecord
from app.services import exchange_rate_service


def _build_active_product_costs_df(
    db: Session,
    *,
    project_name: str,
    country: str,
    year_month: str,
) -> pd.DataFrame:
    """Build DataFrame of active product costs with currency conversion."""
    rows = db.execute(
        select(SkuRecord).where(
            SkuRecord.project_name == project_name,
            SkuRecord.is_active.is_(True),
            SkuRecord.country == country,
        )
    ).scalars().all()
    if not rows:
        raise ValueError(
            f'No active product_costs found for project_name={project_name}, country={country}'
        )

    data: list[dict[str, object]] = []
    for row in rows:
        fob_cost, _ = exchange_rate_service.convert_rmb_to_target_currency(
            row.fob_unit_cost or 0,
            country=country,
            year_month=year_month,
            db=db,
        )
        first_leg_cost, _ = exchange_rate_service.convert_rmb_to_target_currency(
            row.first_leg_cost_rmb or 0,
            country=country,
            year_month=year_month,
            db=db,
        )
        data.append(
            {
                'SKU': row.sku,
                'ASIN': row.asin,
                '头程单价': float(first_leg_cost),
                'FOB单价': float(fob_cost),
            }
        )


    import pandas as pd

    return pd.DataFrame(data)
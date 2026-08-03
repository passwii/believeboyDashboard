"""Service helpers for the external New Product Calculation endpoint.

BEL-378 / BEL-416 — exposes
``GET /api/v1/external/projects/{project_id}/new-product-calculations``.

Wraps ``new_product_calculation_service.list_snapshots`` (which already
supports ``project_id`` / ``calculation_type`` / ``country`` filtering
and pagination) and flattens the result into the public BI shape.

The internal ``NewProductCalculationItem`` carries nested
``dimensions`` / ``weights`` / ``fees`` / ``profit`` sub-objects; the
external schema keeps only the headline economics + lineage columns.
Anything not in ``ROW_WHITELIST[NewProductCalculation]`` is dropped
defense-in-depth alongside the Pydantic schema.
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models import NewProductCalculation
from app.schemas.external.new_product_calculation import (
    NewProductCalculationRow,
)
from app.services import new_product_calculation_service


def list_new_product_calculations(
    db: Session,
    *,
    project_id: int,
    calculation_type: Optional[str] = None,
    country: Optional[str] = None,
    page: int = 1,
    page_size: int = 200,
) -> Tuple[List[NewProductCalculationRow], int]:
    """Return paginated new-product calculation rows for a project.

    Delegates to ``new_product_calculation_service.list_snapshots`` and
    then flattens each ``NewProductCalculationItem`` into the public BI
    shape.

    Parameters
    ----------
    project_id
        Required — the project whose new-product calculation rows to
        fetch.
    calculation_type
        Optional filter (``"profit_calc"``, ``"profit_reverse"`` or
        ``"eu_accounting"``). When supplied, restricts the result to
        rows of that type.
    country
        Optional ISO-2 code. When supplied, restricts the result to
        that country's rows.
    page, page_size
        Pagination params. ``page_size`` is clamped 1..500 by the
        underlying service.

    Returns
    -------
    (rows, total)
        ``rows`` is the flattened list (sorted by ``updated_at DESC``);
        ``total`` is the unpaginated count.
    """
    items, total = new_product_calculation_service.list_snapshots(
        db,
        project_id=project_id,
        calculation_type=calculation_type,
        country=country,
        page=page,
        page_size=page_size,
    )
    rows = [_flatten_row(it) for it in items]
    return rows, total


def _flatten_row(item) -> NewProductCalculationRow:
    """Project a ``NewProductCalculationItem`` onto the public BI shape.

    Reads from the item (already populated by
    ``new_product_calculation_service._to_item``) so we never touch raw
    SQLAlchemy attributes directly.
    """
    return NewProductCalculationRow(
        id=item.id,
        project_id=item.project_id,
        project_name=item.project_name,
        sku=item.sku,
        asin=item.asin,
        country=item.country,
        calculation_type=item.calculation_type,
        sale_price_usd=item.sale_price_usd,
        target_profit_rate=item.target_profit_rate,
        profit_usd=item.profit.profit_usd,
        profit_rate=item.profit.profit_rate,
        payout_usd=item.profit.payout_usd,
        total_fee_usd=item.fees.total_fee_usd,
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


__all__ = [
    "list_new_product_calculations",
    # Re-export the underlying model for callers that need it (e.g.
    # impact analysis / debugging).
    "NewProductCalculation",
]

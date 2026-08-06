"""External New Product Calculation endpoint — BEL-378 / BEL-416.

One read-only route mounted under ``/external/projects/{project_id}``:

* ``/new-product-calculations`` — paginated list of new-product
  calculation rows, filterable by ``?calculation_type=`` and
  ``?country=``.

P0 contract (no auth, no rate limiting). Network isolation is enforced
at the gateway layer per
``docs/deployment/external-api-network-isolation.md``.

Returns 15 flat columns — economics + lineage, no nested objects.
Sensitive / internal columns (``created_by``, ``warnings_json``,
fee-rule labels) are filtered out by the whitelist + Pydantic schema.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._whitelist import parse_order_by
from app.models import NewProductCalculation
from app.schemas.external.common import PeriodParseError
from app.schemas.external.new_product_calculation import (
    NewProductCalculationListResponse,
)
from app.services.external import projects_query
from app.services.external import (
    _new_product_calculations as new_product_calc_svc,
)


router = APIRouter()


# ---------------------------------------------------------------------------
# /new-product-calculations — paginated list
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/new-product-calculations",
    response_model=NewProductCalculationListResponse,
    summary="New Product Calculation list (paginated)",
    description=(
        "Paginated list of new-product calculation rows for the "
        "project. The new-product calculation table "
        "(``new_product_calculations``) is the canonical source for "
        "profit-calc / profit-reverse snapshots; the legacy\n"
        "``store_sku_pricing_snapshots`` table was renamed in 2026-08\n"
        "(migration 230).\n\n"
        "Returns 14 flat columns — economics + lineage, no nested "
        "objects. Use ``?calculation_type=`` to filter, ``?country=`` "
        "to restrict to one country, ``?order_by=`` to sort by any of "
        "the 15 whitelisted columns."
    ),
)
def get_external_new_product_calculations(
    project_id: int = Path(..., ge=1),
    calculation_type: str | None = Query(
        default=None,
        description="Filter by calculation_type (e.g. profit_calc, profit_reverse).",
    ),
    country: str = Query(default=""),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    order_by: str = Query(default="updated_at"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
) -> NewProductCalculationListResponse:
    # BLF-459 (P1)：Deprecation/Sunset/Link 头已由全局 middleware 统一打
    # （app/middleware/external_deprecation.py），此处不再单端点手写。
    try:
        normalized_country = parse_country(country) if country else None
        order_column, direction = parse_order_by(
            order_by, order_dir, model=NewProductCalculation
        )
    except PeriodParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    rows, total = new_product_calc_svc.list_new_product_calculations(
        db,
        project_id=project_id,
        calculation_type=calculation_type,
        country=normalized_country,
        page=page,
        page_size=page_size,
    )

    # Service already orders by ``updated_at DESC, id DESC``; if the
    # caller requested a different sort, reorder in Python. The result
    # set is bounded by ``page_size`` so the cost is negligible.
    if order_by != "updated_at" or order_dir != "desc":
        _apply_in_page_sort(rows, order_column, direction)

    return NewProductCalculationListResponse(
        project_id=project_id,
        country=normalized_country,
        calculation_type=calculation_type,
        total=total,
        page=page,
        page_size=page_size,
        data=rows,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _apply_in_page_sort(rows, order_column, direction: str) -> None:
    """Sort a Python list of ``NewProductCalculationRow`` by a column.

    The whitelist guarantees ``order_column`` is a ``ColumnElement``
    whose ``.key`` attribute maps back to one of the 14 Pydantic
    fields. ``None`` values always sink to the bottom regardless of
    direction.
    """
    if not rows:
        return
    sort_key_name = getattr(order_column, "key", None)
    if not sort_key_name or not hasattr(rows[0], sort_key_name):
        return
    reverse = direction == "desc"

    def _key(row):
        v = getattr(row, sort_key_name)
        if v is None:
            return (1, 0)
        return (0, v)

    rows.sort(key=_key, reverse=reverse)

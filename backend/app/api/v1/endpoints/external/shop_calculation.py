"""External Shop Calculation endpoints — BEL-378 / BEL-416.

Three read-only routes mounted under ``/external/projects/{project_id}``:

* ``/shop-calculation-history`` — current-state list (per SKU latest
  non-deleted row), filterable by ``?country=`` and paginated.
* ``/shop-calculation/snapshots`` — append-only time series filtered
  by ``?from=&to=&sku=&country=``.

P0 contract (no auth, no rate limiting). Network isolation is enforced
at the gateway layer per
``docs/deployment/external-api-network-isolation.md``.

Both endpoints share the BI-friendly flat
``ShopCalculationHistoryRow`` shape (16 columns). Sensitive / internal
columns (``created_by``, ``deleted_at``, ``warnings_json``,
fee-rule labels) are filtered out by the whitelist + Pydantic schema.
"""

from __future__ import annotations

from datetime import date as date_t

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.api.v1.endpoints.external._whitelist import parse_order_by
from app.models import ShopCalculation
from app.schemas.external.common import PeriodParseError
from app.schemas.external.shop_calculation import (
    ShopCalculationHistoryResponse,
    ShopCalculationSnapshotsResponse,
)
from app.services.external import projects_query
from app.services.external import _shop_calculation as shop_calc_svc


router = APIRouter()


# ---------------------------------------------------------------------------
# /shop-calculation-history — current-state list
# ---------------------------------------------------------------------------


@router.get(
    "/projects/{project_id}/shop-calculation-history",
    response_model=ShopCalculationHistoryResponse,
    summary="Shop Calculation current-state list (per SKU latest row)",
    description=(
        "Current-state list of shop-calculation rows for the project.\n\n"
        "Each row is the latest non-deleted entry for a "
        "``(project_id, sku, country)`` group (BEL-378 append-only). "
        "Returns 15 flat columns — economics + lineage, no nested "
        "objects.\n\n"
        "Use ``?country=US`` to restrict to a single country. "
        "Use ``?order_by=`` to sort by any of the 16 whitelisted columns."
    ),
)
def get_external_shop_calculation_history(
    project_id: int = Path(..., ge=1),
    country: str = Query(default=""),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    order_by: str = Query(default="observed_at"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
) -> ShopCalculationHistoryResponse:
    try:
        normalized_country = parse_country(country) if country else None
        order_column, direction = parse_order_by(
            order_by, order_dir, model=ShopCalculation
        )
    except PeriodParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    rows, total = shop_calc_svc.list_shop_calculation_history(
        db,
        project_id=project_id,
        country=normalized_country,
        page=page,
        page_size=page_size,
    )

    # Service already orders by ``observed_at DESC, id DESC``; if the
    # caller requested a different sort, reorder in Python. The result
    # set is bounded by ``page_size`` so the cost is negligible.
    if order_by != "observed_at" or order_dir != "desc":
        _apply_in_page_sort(rows, order_column, direction)

    return ShopCalculationHistoryResponse(
        project_id=project_id,
        country=normalized_country,
        total=total,
        data=rows,
    )


# ---------------------------------------------------------------------------
# /shop-calculation/snapshots — append-only time series
# ---------------------------------------------------------------------------


def _parse_iso_date(value: str | None, *, field: str) -> date_t | None:
    """Parse a YYYY-MM-DD string. None / empty returns None.

    Raises ``PeriodParseError`` on malformed input.
    """
    if not value or not value.strip():
        return None
    try:
        return date_t.fromisoformat(value.strip()[:10])
    except ValueError as exc:
        raise PeriodParseError(f"{field} must be YYYY-MM-DD, got {value!r}") from exc


@router.get(
    "/projects/{project_id}/shop-calculation/snapshots",
    response_model=ShopCalculationSnapshotsResponse,
    summary="Shop Calculation time series (append-only history)",
    description=(
        "Append-only history of shop-calculation rows for the project.\n\n"
        "Each row is one observation — the same SKU/country group may "
        "appear multiple times across different ``observed_at`` "
        "snapshots. Use ``?from=&to=`` to bound the date window, "
        "``?sku=`` and ``?country=`` to filter.\n\n"
        "Returns the same 15 flat columns as the current-state endpoint.\n"
        "When ``?from=`` is greater than ``?to=`` the endpoint returns "
        "400 (defense-in-depth alongside the date parsing)."
    ),
)
def get_external_shop_calculation_snapshots(
    project_id: int = Path(..., ge=1),
    from_date: str | None = Query(
        default=None,
        description="Inclusive lower bound (YYYY-MM-DD). Defaults to no lower bound.",
    ),
    to_date: str | None = Query(
        default=None,
        description="Inclusive upper bound (YYYY-MM-DD). Defaults to no upper bound.",
    ),
    sku: str | None = Query(
        default=None,
        description="Exact-match SKU filter (case-sensitive).",
    ),
    country: str = Query(default=""),
    db: Session = Depends(get_read_db_session),
) -> ShopCalculationSnapshotsResponse:
    try:
        from_d = _parse_iso_date(from_date, field="from_date")
        to_d = _parse_iso_date(to_date, field="to_date")
        normalized_country = parse_country(country) if country else None
        if from_d is not None and to_d is not None and from_d > to_d:
            raise PeriodParseError(
                f"from_date must be <= to_date, got {from_d} > {to_d}"
            )
    except PeriodParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    rows = shop_calc_svc.list_shop_calculation_snapshots(
        db,
        project_id=project_id,
        from_date=from_d,
        to_date=to_d,
        sku=sku,
        country=normalized_country,
    )

    return ShopCalculationSnapshotsResponse(
        project_id=project_id,
        from_date=from_date,
        to_date=to_date,
        sku=sku,
        country=normalized_country,
        total=len(rows),
        data=rows,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _apply_in_page_sort(rows, order_column, direction: str) -> None:
    """Sort a Python list of ``ShopCalculationHistoryRow`` by a column.

    The whitelist guarantees ``order_column`` is a ``ColumnElement``
    whose ``.key`` attribute maps back to one of the 15 Pydantic fields
    (e.g. ``observed_at``, ``profit_usd``). Non-numeric columns
    (notably ``observed_at``) sort by the natural Python order; ``None``
    values always sink to the bottom regardless of direction.
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
            # Push None to the end regardless of direction.
            return (1, 0)
        return (0, v)

    rows.sort(key=_key, reverse=reverse)

"""External Pricing Snapshot endpoint — BEL-378 / BEL-416.

One read-only route mounted under ``/external/projects/{project_id}``:

* ``/pricing-snapshots?as_of=YYYY-MM-DD`` — return the latest catalog
  freeze (``pricing_calculation_snapshots`` row) whose
  ``snapshot_date`` is on or before ``as_of``.

P0 contract (no auth, no rate limiting). Network isolation is enforced
at the gateway layer per
``docs/deployment/external-api-network-isolation.md``.

The endpoint is the BI-friendly way to recover a "catalog state as of
date X" — a frozen view of all (project, country, sku) economics at
the moment the snapshot was created. When ``as_of`` is omitted the
endpoint returns the most recent snapshot (no date constraint).
"""

from __future__ import annotations

from datetime import date as date_t

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_country
from app.schemas.external.common import PeriodParseError
from app.schemas.external.shop_calculation import (
    ShopCalculationSnapshotsResponse,
)
from app.services.external import projects_query
from app.services.external import (
    _pricing_calculation_snapshot as pricing_snap_svc,
)


router = APIRouter()


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
    "/projects/{project_id}/pricing-snapshots",
    response_model=ShopCalculationSnapshotsResponse,
    summary="Pricing catalog freeze as of date",
    description=(
        "Return the latest pricing snapshot (``pricing_calculation_snapshots``) "
        "whose ``snapshot_date`` is on or before ``as_of``. When "
        "``as_of`` is omitted the endpoint returns the most recent snapshot.\n\n"
        "Each item is one SKU's economics at the freeze moment. The "
        "same 15 flat columns as the shop-calculation endpoints — "
        "sale price, profit, fees, observed_at (snapshot's create "
        'time), source (``"manual"``), and timestamps.\n\n'
        "Returns 404 when no snapshot exists for the "
        "(project, country, as_of) tuple."
    ),
)
def get_external_pricing_snapshot_as_of(
    project_id: int = Path(..., ge=1),
    as_of: str | None = Query(
        default=None,
        description="Inclusive upper bound (YYYY-MM-DD). Defaults to no upper bound (most recent snapshot).",
    ),
    country: str = Query(default="US"),
    db: Session = Depends(get_read_db_session),
) -> ShopCalculationSnapshotsResponse:
    try:
        normalized_country = parse_country(country)
        as_of_date = _parse_iso_date(as_of, field="as_of")
    except PeriodParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    snapshot_id, rows = pricing_snap_svc.find_pricing_snapshot_as_of(
        db,
        project_id=project_id,
        country=normalized_country,
        as_of=as_of_date,
    )
    if snapshot_id is None:
        if as_of_date is not None:
            detail = (
                f"no pricing snapshot for project {project_id} in "
                f"{normalized_country} on or before {as_of_date.isoformat()}"
            )
        else:
            detail = (
                f"no pricing snapshot for project {project_id} in {normalized_country}"
            )
        raise HTTPException(status_code=404, detail=detail)

    return ShopCalculationSnapshotsResponse(
        project_id=project_id,
        from_date=None,
        to_date=as_of,
        sku=None,
        country=normalized_country,
        total=len(rows),
        data=rows,
    )

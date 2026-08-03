"""Service helpers for the external pricing-snapshot endpoint.

BEL-378 / BEL-416 — exposes
``GET /api/v1/external/projects/{project_id}/pricing-snapshots?as_of=YYYY-MM-DD``.

Returns the **latest catalog freeze** (a ``pricing_calculation_snapshots``
row) whose ``snapshot_date`` is on or before ``as_of``. If ``as_of`` is
omitted, the endpoint falls back to the most recent snapshot (no date
constraint).

Internally, the row is fetched via
``pricing_calculation_snapshot_service.get_snapshot_detail`` which
returns the full snapshot detail (header + items) where ``items`` is
already shaped like ``ShopCalculationItem``. We flatten the items into
the public BI shape so the response is consistent with the other
external calculation endpoints.

Note: the underlying snapshot items table does not store
``created_by`` / standalone ``observed_at`` / ``source`` — those
columns come from the snapshot header (synthetic id = ``snapshot_id *
1_000_000 + source_row_no``).
"""

from __future__ import annotations

from datetime import date
from typing import List, Optional

from sqlalchemy.orm import Session

from app.services import pricing_calculation_snapshot_service
from app.schemas.external.shop_calculation import ShopCalculationHistoryRow


def find_pricing_snapshot_as_of(
    db: Session,
    *,
    project_id: int,
    country: str,
    as_of: Optional[date] = None,
) -> tuple[int | None, List[ShopCalculationHistoryRow]]:
    """Return ``(snapshot_id, rows)`` for the latest snapshot ≤ ``as_of``.

    Returns ``(None, [])`` if no snapshot exists for the project/country
    within the window. Callers should treat that as 404 (caller knows
    whether they want 404 vs empty).

    The function does **not** validate project existence; the endpoint
    layer wraps ``projects_query.project_exists`` for 404 handling.
    """
    snapshot_id = _find_latest_snapshot_id(
        db, project_id=project_id, country=country, as_of=as_of
    )
    if snapshot_id is None:
        return None, []

    detail = pricing_calculation_snapshot_service.get_snapshot_detail(db, snapshot_id)
    if detail is None:
        # Snapshot was deleted between the id lookup and detail fetch —
        # race condition; treat as not found.
        return None, []

    rows: List[ShopCalculationHistoryRow] = []
    for item in detail.items:
        rows.append(
            ShopCalculationHistoryRow(
                id=item.id,
                project_id=item.project_id,
                project_name=item.project_name,
                sku=item.sku,
                asin=item.asin,
                country=item.country,
                accounting_type=item.accounting_type,
                # Snapshot items inherit observed_at / source from header
                # — see ``_snapshot_item_to_dto`` in the snapshot service.
                observed_at=item.observed_at,
                source=item.source,
                sale_price_usd=item.sale_price_usd,
                profit_usd=item.profit.profit_usd,
                profit_rate=item.profit.profit_rate,
                payout_usd=item.profit.payout_usd,
                total_fee_usd=item.fees.total_fee_usd,
                created_at=item.created_at,
                updated_at=item.updated_at,
            )
        )
    return snapshot_id, rows


def _find_latest_snapshot_id(
    db: Session,
    *,
    project_id: int,
    country: str,
    as_of: Optional[date],
) -> Optional[int]:
    """Return the id of the latest snapshot ≤ ``as_of`` (or any date if None).

    Walks ``pricing_calculation_snapshot_service.list_snapshots`` which is
    already sorted by ``snapshot_date DESC``. We pick the first row whose
    ``snapshot_date`` is ≤ ``as_of`` when supplied; otherwise the very
    first row.
    """
    # list_snapshots applies an internal page cap (1..100). For an
    # append-only catalog that is still a few hundred rows per project —
    # but we only need the head of the list (it's already DESC sorted),
    # so the cap is fine.
    snapshots = pricing_calculation_snapshot_service.list_snapshots(
        db,
        project_id=project_id,
        country=country,
        page=1,
        page_size=100,
    )
    if not snapshots:
        return None
    if as_of is None:
        return snapshots[0].id
    for snap in snapshots:
        snap_date = snap.snapshot_date
        if snap_date is None:
            continue
        # ``snapshot_date`` is a ``datetime`` on the model.
        snap_day = snap_date.date() if hasattr(snap_date, "date") else snap_date
        if snap_day <= as_of:
            return snap.id
    return None


__all__ = ["find_pricing_snapshot_as_of"]

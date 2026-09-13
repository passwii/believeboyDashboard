"""Service helpers for the Shop Calculation read-query endpoints.

原 external 命名空间的共享服务（external 机制已退役删除，BLF-583），
供 agent 原生域复用。

BEL-378 / BEL-416 — exposes two endpoints:

* ``/shop-calculation-history`` — current-state list (per SKU latest
  non-deleted row). Wraps ``shop_calculation_service.list_by_project``.
* ``/shop-calculation/snapshots`` — append-only time series filtered
  by ``?from=&to=&sku=&country=``. Wraps
  ``shop_calculation_service.list_history``.

The wrappers convert the internal ``ShopCalculationItem`` shape (with
its nested ``dimensions`` / ``weights`` / ``fees`` / ``profit``
sub-objects) into the flat BI-friendly
``ShopCalculationHistoryRow`` shape. Anything not in the
``ROW_WHITELIST[ShopCalculation]`` whitelist is dropped here
defense-in-depth alongside the Pydantic schema.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy.orm import Session

from app.models import ShopCalculation
from app.schemas.external.shop_calculation import ShopCalculationHistoryRow
from app.services import shop_calculation_service


def list_shop_calculation_history(
    db: Session,
    *,
    project_id: int,
    country: str | None = None,
    page: int = 1,
    page_size: int = 200,
    target_net_margin: float | None = None,
) -> tuple[list[ShopCalculationHistoryRow], int]:
    """Return the current-state list of ShopCalculation rows for a project.

    Delegates to ``shop_calculation_service.list_by_project`` (which
    already applies ``latest_stmt`` + soft-delete filtering) and then
    flattens each ``ShopCalculationItem`` into the public BI shape.

    Parameters
    ----------
    project_id
        Required — the project whose current-state rows to fetch.
    country
        Optional ISO-2 code (e.g. ``"US"``, ``"DE"``, ``"UK"``). When
        supplied, restricts the result to that country's rows.
    page, page_size
        Pagination params. ``page_size`` is clamped 1..500 by the
        underlying service.
    target_net_margin
        Optional target net margin (BLF-1043). When supplied, each row
        also carries ``target_advertising_rate``.

    Returns
    -------
    (rows, total)
        ``rows`` is the flattened list (already sorted by
        ``observed_at DESC``); ``total`` is the unpaginated count.
    """
    items, total = shop_calculation_service.list_by_project(
        db,
        project_id=project_id,
        country=country,
        page=page,
        page_size=page_size,
        target_net_margin=target_net_margin,
    )
    rows = [_flatten_history_row(it) for it in items]
    return rows, total


def list_shop_calculation_snapshots(
    db: Session,
    *,
    project_id: int,
    from_date: date | None = None,
    to_date: date | None = None,
    sku: str | None = None,
    country: str | None = None,
    include_deleted: bool = False,
    target_net_margin: float | None = None,
) -> list[ShopCalculationHistoryRow]:
    """Return the append-only time-series rows for a project.

    Delegates to ``shop_calculation_service.list_history`` (which
    already orders by ``observed_at DESC`` and filters soft-deleted
    rows unless ``include_deleted=True``) and then applies the
    ``from_date`` / ``to_date`` window in Python.

    The date filter is applied in Python (not SQL) because
    ``list_history`` does not currently expose a date filter and the
    expected result set is bounded by the explicit ``?from=&to=`` call.
    A ``?from=2024-01-01&to=2026-08-03`` window on a real project is at
    most a few thousand rows — well within Python-list filter territory.
    """
    items = shop_calculation_service.list_history(
        db,
        project_id=project_id,
        sku=sku,
        country=country,
        include_deleted=include_deleted,
        target_net_margin=target_net_margin,
    )
    out: list[ShopCalculationHistoryRow] = []
    for it in items:
        observed = getattr(it, "observed_at", None)
        if (
            from_date is not None
            and observed is not None
            and observed.date() < from_date
        ):
            continue
        if to_date is not None and observed is not None and observed.date() > to_date:
            continue
        out.append(_flatten_history_row(it))
    return out


def _flatten_history_row(item) -> ShopCalculationHistoryRow:
    """Project a ``ShopCalculationItem`` onto the public BI shape.

    Reads from the item (already populated by
    ``shop_calculation_service._to_item``) so we never touch raw SQLAlchemy
    attributes directly. The mapping is hand-written (no Pydantic
    ``from_attributes`` magic) so that adding a field here is a
    deliberate, reviewable change.

    BLF-1043：扁平行带有费用拆项（item.fees / item.profit），所以锚能在服务端
    算出来 —— 挂到三个派生列上。消费方拿到的扁平行没有任何 fee 明细，自己算
    不出锚，故必须由服务端（唯一的公式落点 ``pricing.anchor``）推。
    """
    anchor = getattr(item, "anchor", None)
    return ShopCalculationHistoryRow(
        id=item.id,
        project_id=item.project_id,
        project_name=item.project_name,
        sku=item.sku,
        asin=item.asin,
        country=item.country,
        accounting_type=item.accounting_type,
        observed_at=item.observed_at,
        source=item.source,
        # Flatten the nested ``profit`` object — BI tools do not want
        # to dereference ``profit.profit_usd`` for thousands of rows.
        sale_price_usd=item.sale_price_usd,
        profit_usd=item.profit.profit_usd,
        profit_rate=item.profit.profit_rate,
        payout_usd=item.profit.payout_usd,
        total_fee_usd=item.fees.total_fee_usd,
        breakeven_advertising_rate=(
            anchor.breakeven_advertising_rate if anchor is not None else None
        ),
        max_ad_spend_per_unit_usd=(
            anchor.max_ad_spend_per_unit_usd if anchor is not None else None
        ),
        target_advertising_rate=(
            anchor.target_advertising_rate if anchor is not None else None
        ),
        created_at=item.created_at,
        updated_at=item.updated_at,
    )


__all__ = [
    "list_shop_calculation_history",
    "list_shop_calculation_snapshots",
    # Re-export the underlying model for callers that need it (e.g.
    # impact analysis / debugging).
    "ShopCalculation",
]

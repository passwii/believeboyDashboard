"""Shared service layer for Return Analysis (BEL-374).

原 external 命名空间的共享查询服务（external 机制已退役删除，BLF-583），
供 agent 原生域复用。

Two query paths:

* :func:`query_return_analysis_aggregate` — read pre-aggregated per-day
  snapshot rows from ``analysis_return_aggregates``, then collapse to
  per-SKU rollups in Python for the requested period. Returns rows in
  the ``ReturnAnalysisAggregateRow`` shape, with ``risk_level``
  re-derived from the rollup totals using the same Wilson rule as the
  internal endpoint (keeps the contract stable across schema versions).
* :func:`query_return_analysis_raw` — read ``analysis_return_rows``
  directly, scoped by project / country / date range. The Pydantic
  schema ``ReturnAnalysisRawRow`` strips ``customer_comments`` and
  ``raw_row`` so the contract guarantees they cannot leak.

Why Python-side aggregation?
---------------------------
The aggregate table is daily-grain, but external callers want one
row per SKU within the window. The natural query is:

    SELECT sku,
           SUM(return_quantity), SUM(sales_quantity), ...
    FROM analysis_return_aggregates
    WHERE data_date BETWEEN :start AND :end
    GROUP BY sku

This works, but:

* Computing ``wilson_lower`` per row requires Python (``utils.stats``),
  so we'd need a hybrid anyway.
* Picking ``reason_top1`` / ``disposition_top1`` / ``dominant_fc_id``
  needs an aggregate-aware "argmax" that PG supports via
  ``DISTINCT ON`` but SQLite (test DB) doesn't.

We therefore:

1. Pull all per-SKU-per-day rows from the snapshot in one bounded
   SQL fetch (``GROUP BY sku, data_date`` to avoid blowing the
   in-RAM budget — see :func:`_fetch_per_sku_per_day`).
2. Collapse to per-SKU rollups in Python: sum quantities, recompute
   Wilson, pick worst risk_level, pick top-1 reason by max-day weight.
3. Apply filter / order / pagination in Python on the per-SKU list.

For a single project × country × 90 days × ≤10k SKUs, the working set
fits comfortably under 100k rows (each row is small). The DB index
``idx_return_agg_project_sku_date`` already covers the fetch.

If a project grows past this, we'll move the aggregation server-side
and re-introduce a single ``GROUP BY sku`` SELECT. Until then, the
Python-side approach keeps PG + SQLite test parity clean.
"""

from __future__ import annotations

from datetime import date
from typing import Iterable

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.models import AnalysisReturnAggregate, AnalysisReturnRow
from app.utils.stats import wilson_lower_bound, compute_risk_level


# ---------------------------------------------------------------------------
# Aggregate query — collapse daily snapshots to per-SKU rollups.
# ---------------------------------------------------------------------------


_RISK_RANK = {"critical": 4, "warning": 3, "normal": 2, "no_data": 1}


def _build_aggregate_filters(
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    sku_substring: str | None,
):
    """Compose the WHERE clause for both the aggregate fetch and the
    distinct-SKU count.
    """
    conditions = [
        AnalysisReturnAggregate.project_id == project_id,
        AnalysisReturnAggregate.country == country,
        AnalysisReturnAggregate.data_date >= date_from,
        AnalysisReturnAggregate.data_date <= date_to,
    ]
    if sku_substring:
        # Substring match, case-insensitive at the SQL level. The
        # snapshot table stores SKU verbatim, so we lower() both sides
        # to keep the query portable across PG / SQLite tests.
        like = f"%{sku_substring.lower()}%"
        conditions.append(func.lower(AnalysisReturnAggregate.sku).like(like))
    return and_(*conditions)


def _fetch_per_sku_per_day(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    sku_substring: str | None,
) -> list[dict]:
    """Fetch all (sku, data_date) rows within the window.

    Returned dicts carry the fields we need to derive the
    per-SKU rollup: return_count / return_quantity / sales_quantity /
    daily_sales_quantity / cycle_* / reason_top1 /
    disposition_top1 / dominant_fc_id / risk_level.
    """
    filters = _build_aggregate_filters(
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        sku_substring=sku_substring,
    )
    stmt = select(
        AnalysisReturnAggregate.sku,
        AnalysisReturnAggregate.return_count,
        AnalysisReturnAggregate.return_quantity,
        AnalysisReturnAggregate.sales_quantity,
        AnalysisReturnAggregate.daily_sales_quantity,
        AnalysisReturnAggregate.cycle_avg_days,
        AnalysisReturnAggregate.cycle_min_days,
        AnalysisReturnAggregate.cycle_max_days,
        AnalysisReturnAggregate.reason_top1,
        AnalysisReturnAggregate.disposition_top1,
        AnalysisReturnAggregate.dominant_fc_id,
        AnalysisReturnAggregate.risk_level,
    ).where(filters)
    rows = db.execute(stmt).all()
    return [
        {
            "sku": r.sku,
            "return_count": int(r.return_count or 0),
            "return_quantity": int(r.return_quantity or 0),
            "sales_quantity": int(r.sales_quantity or 0),
            # BLF-806: 窗口销量口径用当日销量；NULL=迁移前旧行，按 0 计，
            # 待每日刷新任务缺口检测自愈后即为准确值。
            "daily_sales_quantity": int(r.daily_sales_quantity or 0),
            "cycle_avg_days": r.cycle_avg_days,
            "cycle_min_days": r.cycle_min_days,
            "cycle_max_days": r.cycle_max_days,
            "reason_top1": r.reason_top1,
            "disposition_top1": r.disposition_top1,
            "dominant_fc_id": r.dominant_fc_id,
            "risk_level": (r.risk_level or "no_data").lower(),
        }
        for r in rows
    ]


def _collapse_to_per_sku(rows: Iterable[dict]) -> list[dict]:
    """Collapse per-(sku, data_date) rows into per-SKU rollups.

    For each SKU we:

    * ``return_count`` / ``return_quantity`` / ``sales_quantity`` — sum.
      ``sales_quantity`` sums the per-day ``daily_sales_quantity``
      (BLF-806), which equals the window's counted sales and matches
      the R1 overview denominator. (Historic note: before BLF-806 this
      took ``max`` of the cumulative-through-date column — a full-history
      total that inflated every return_rate.)
    * ``cycle_avg_days`` — weighted average by return_quantity
      (matches the internal endpoint math, see BEL-373 observation
      "Wilson 公式精确值" lesson).
    * ``cycle_min_days`` — min across days.
    * ``cycle_max_days`` — max across days.
    * ``wilson_lower``   — recompute from the rollup totals using the
      Python Wilson formula. This keeps the contract stable: agents
      comparing snapshots over time see a value derived from the
      combined window, not a noisy per-day pick.
    * ``return_rate``    — recompute from rollup totals (same reason).
    * ``risk_level``     — worst observed across the window
      (critical > warning > normal > no_data). This is *not* identical
      to ``compute_risk_level(return_quantity, sales_quantity)`` —
      the latter would re-evaluate Wilson on the rollup; we choose the
      worst of the daily risk_levels because the snapshot already ran
      the Wilson check, and treating each day independently avoids
      smoothing away genuine spikes.
    * ``reason_top1``    — pick the row with the largest
      ``return_quantity``; tiebreak by data_date (most recent first).
      We don't carry ``data_date`` through because the schema only
      exposes the rolled-up value, not which day it came from.
    """
    by_sku: dict[str, dict] = {}
    for r in rows:
        sku = r["sku"]
        if sku not in by_sku:
            by_sku[sku] = {
                "sku": sku,
                "return_count": 0,
                "return_quantity": 0,
                "sales_quantity": 0,
                "_cycle_weighted_sum": 0.0,
                "_cycle_min": None,
                "_cycle_max": None,
                "_reason_top1": None,
                "_reason_top1_weight": -1,
                "_disposition_top1": None,
                "_disposition_top1_weight": -1,
                "_dominant_fc_id": None,
                "_dominant_fc_id_weight": -1,
                "_risk_worst": "no_data",
            }
        agg = by_sku[sku]
        agg["return_count"] += r["return_count"]
        agg["return_quantity"] += r["return_quantity"]
        # BLF-806: 窗口销量 = Σ当日销量（与 R1 overview 同窗口同口径）；
        # None=迁移前旧行，按 0 计（待刷新任务自愈）。
        agg["sales_quantity"] += r["daily_sales_quantity"] or 0

        # Weighted cycle avg: weight by return_quantity (matches the
        # internal endpoint math).
        if r["cycle_avg_days"] is not None and r["return_quantity"] > 0:
            agg["_cycle_weighted_sum"] += (
                float(r["cycle_avg_days"]) * r["return_quantity"]
            )
        if r["cycle_min_days"] is not None:
            cur_min = agg["_cycle_min"]
            agg["_cycle_min"] = (
                r["cycle_min_days"]
                if cur_min is None
                else min(cur_min, r["cycle_min_days"])
            )
        if r["cycle_max_days"] is not None:
            cur_max = agg["_cycle_max"]
            agg["_cycle_max"] = (
                r["cycle_max_days"]
                if cur_max is None
                else max(cur_max, r["cycle_max_days"])
            )

        # Argmax by return_quantity for top-1 picks.
        weight = r["return_quantity"]
        if weight > agg["_reason_top1_weight"] and r["reason_top1"]:
            agg["_reason_top1"] = r["reason_top1"]
            agg["_reason_top1_weight"] = weight
        if weight > agg["_disposition_top1_weight"] and r["disposition_top1"]:
            agg["_disposition_top1"] = r["disposition_top1"]
            agg["_disposition_top1_weight"] = weight
        if weight > agg["_dominant_fc_id_weight"] and r["dominant_fc_id"]:
            agg["_dominant_fc_id"] = r["dominant_fc_id"]
            agg["_dominant_fc_id_weight"] = weight

        # Worst risk level (rank-based).
        if _RISK_RANK.get(r["risk_level"], 0) > _RISK_RANK.get(agg["_risk_worst"], 0):
            agg["_risk_worst"] = r["risk_level"]

    # Finalize into the schema shape.
    out: list[dict] = []
    for sku, agg in by_sku.items():
        rq = agg["return_quantity"]
        sq = agg["sales_quantity"]
        # risk_level 从 rolled totals 重算（与 internal endpoint 一致），
        # 不取"worst across daily rows"——逐日行独立判定会漏掉跨日累积的
        # 风险，且窗口口径下分母应以整个窗口为准。
        risk_level, _ = compute_risk_level(rq, sq)
        cycle_avg = (
            round(agg["_cycle_weighted_sum"] / rq, 2)
            if rq > 0 and agg["_cycle_weighted_sum"] > 0
            else None
        )
        out.append(
            {
                "sku": sku,
                "return_count": agg["return_count"],
                "return_quantity": rq,
                "sales_quantity": sq,
                "return_rate": round(rq * 100.0 / sq, 3) if sq > 0 else 0.0,
                "wilson_lower": round(wilson_lower_bound(rq, sq), 3),
                "cycle_avg_days": cycle_avg,
                "cycle_min_days": agg["_cycle_min"],
                "cycle_max_days": agg["_cycle_max"],
                "reason_top1": agg["_reason_top1"],
                "disposition_top1": agg["_disposition_top1"],
                "dominant_fc_id": agg["_dominant_fc_id"],
                "risk_level": risk_level,
            }
        )
    return out


def _apply_post_filters(
    rows: list[dict],
    *,
    min_return_rate: float | None,
    risk_level: str | None,
) -> list[dict]:
    """Apply the rate / risk filters that don't translate cleanly to SQL."""
    out = rows
    if min_return_rate is not None:
        out = [r for r in out if r["return_rate"] >= min_return_rate]
    if risk_level:
        out = [r for r in out if r["risk_level"] == risk_level]
    return out


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def query_return_analysis_aggregate(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    order_column,  # callable (row_dict) -> sort key
    order_dir: str,  # "asc" | "desc"
    limit: int,
    offset: int,
    sku_substring: str | None = None,
    min_return_rate: float | None = None,
    risk_level: str | None = None,
) -> tuple[list[dict], int]:
    """Fetch one page of per-SKU return-analysis rollups + total count.

    Parameters
    ----------
    project_id, country
        Tenant scope.
    date_from, date_to
        Period window (inclusive, on ``data_date``).
    order_column
        Callable extracting the sort key from a per-SKU rollup dict
        (the whitelist validator returns this). Allows sorting on
        any of the 12 fields by name.
    order_dir
        ``"asc"`` or ``"desc"``.
    limit, offset
        Standard pagination (1 ≤ limit ≤ 500, offset ≥ 0).
    sku_substring
        Optional substring filter on SKU (SQL-side, case-insensitive).
    min_return_rate, risk_level
        Optional filters applied in Python after the rollup.

    Returns
    -------
    (rows, total)
        ``rows`` — list of dicts matching ``ReturnAnalysisAggregateRow``
        field names. ``total`` — total SKU count matching the filter
        (independent of pagination).
    """
    per_day = _fetch_per_sku_per_day(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        sku_substring=sku_substring,
    )
    per_sku = _collapse_to_per_sku(per_day)
    per_sku = _apply_post_filters(
        per_sku,
        min_return_rate=min_return_rate,
        risk_level=risk_level,
    )

    total = len(per_sku)
    per_sku.sort(key=order_column, reverse=(order_dir == "desc"))
    page = per_sku[offset : offset + limit]
    return page, total


def query_return_analysis_raw(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    order_column,  # SQLAlchemy InstrumentedAttribute
    order_dir: str,  # "asc" | "desc"
    limit: int,
    offset: int,
) -> tuple[list[dict], date, date]:
    """Fetch one page of raw ``analysis_return_rows`` events.

    Returns
    -------
    (rows, min_date, max_date)
        ``rows`` — list of dicts matching ``ReturnAnalysisRawRow``
        (Pydantic schema enforces field whitelist at serialization).
        ``min_date`` / ``max_date`` — actual data span within the
        requested window. When no rows match, returns
        ``(date_to, date_to)`` to keep the response shape valid.
    """
    filters = and_(
        AnalysisReturnRow.project_id == project_id,
        AnalysisReturnRow.country == country,
        AnalysisReturnRow.return_date >= date_from,
        AnalysisReturnRow.return_date <= date_to,
    )
    stmt = select(AnalysisReturnRow).where(filters)
    stmt = stmt.order_by(
        order_column.asc() if order_dir == "asc" else order_column.desc()
    )
    stmt = stmt.limit(limit).offset(offset)

    rows = db.execute(stmt).scalars().all()

    if rows:
        dates = [r.return_date for r in rows if r.return_date is not None]
        if dates:
            min_d, max_d = min(dates), max(dates)
        else:
            min_d, max_d = date_to, date_to
    else:
        min_d, max_d = date_to, date_to

    # Serialize to dict. The Pydantic schema ``ReturnAnalysisRawRow``
    # declares 12 fields; anything else is dropped on serialization.
    # This is the load-bearing guarantee that ``customer_comments``
    # and ``raw_row`` can never leak — we don't even pass them to the
    # Pydantic constructor.
    out: list[dict] = []
    for r in rows:
        out.append(
            {
                "id": r.id,
                "return_date": r.return_date.isoformat() if r.return_date else None,
                "order_id": r.order_id,
                "sku": r.sku,
                "asin": r.asin,
                "product_name": r.product_name,
                "quantity": r.quantity,
                "fulfillment_center_id": r.fulfillment_center_id,
                "detailed_disposition": r.detailed_disposition,
                "reason": r.reason,
                "status": r.status,
                "original_return_datetime": r.original_return_datetime,
            }
        )
    return out, min_d, max_d


# ---------------------------------------------------------------------------
# Summary helpers — used by the endpoint to populate
# ``ReturnAnalysisAggregateSummary``.
# ---------------------------------------------------------------------------


def build_aggregate_summary(rows: list[dict]) -> dict:
    """Compute summary stats from the already-paginated rollups.

    Note: totals reflect only the *current page*, not the entire
    matching dataset — by design, ``summary`` mirrors the ``data``
    list (cf. ad_campaigns ``build_aggregate_summary``). Callers that
    need dataset-wide totals should sum themselves from the full
    result set across pages.
    """
    total_return_count = sum(int(r.get("return_count") or 0) for r in rows)
    total_return_quantity = sum(int(r.get("return_quantity") or 0) for r in rows)
    total_sales_quantity = sum(int(r.get("sales_quantity") or 0) for r in rows)
    overall_return_rate = (
        round(total_return_quantity * 100.0 / total_sales_quantity, 3)
        if total_sales_quantity > 0
        else 0.0
    )
    overall_risk_level = "no_data"
    for r in rows:
        lvl = (r.get("risk_level") or "no_data").lower()
        if _RISK_RANK.get(lvl, 0) > _RISK_RANK.get(overall_risk_level, 0):
            overall_risk_level = lvl
    critical_sku_count = sum(
        1 for r in rows if (r.get("risk_level") or "").lower() == "critical"
    )
    warning_sku_count = sum(
        1 for r in rows if (r.get("risk_level") or "").lower() == "warning"
    )
    return {
        "total_rows": len(rows),
        "total_return_count": total_return_count,
        "total_return_quantity": total_return_quantity,
        "total_sales_quantity": total_sales_quantity,
        "overall_return_rate": overall_return_rate,
        "overall_risk_level": overall_risk_level,
        "critical_sku_count": critical_sku_count,
        "warning_sku_count": warning_sku_count,
    }


__all__ = [
    "query_return_analysis_aggregate",
    "query_return_analysis_raw",
    "build_aggregate_summary",
]

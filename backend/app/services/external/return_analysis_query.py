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

from collections import Counter
from datetime import date

from sqlalchemy import and_, func, select
from sqlalchemy.orm import Session

from app.constants.return_thresholds import MIN_SALES_FOR_RISK_LEVEL
from app.models import (
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
)
from app.services.sales_query import counted_sales_where
from app.utils.stats import compute_risk_level, wilson_lower_bound

# ---------------------------------------------------------------------------
# Aggregate query — collapse current raw return rows to per-SKU rollups.
# ---------------------------------------------------------------------------


_RISK_RANK = {"critical": 4, "warning": 3, "normal": 2, "no_data": 1}


def _as_int(value) -> int:
    """Coerce a counter value to ``int``, treating ``None`` / junk as 0.

    Values here come from our own aggregation layer, so this only guards the
    ``None`` case rather than parsing untrusted text — but keeping the
    coercion in one place makes the intent explicit and keeps the callers
    free of bare ``int(...)``.
    """
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _fetch_window_return_rows(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    sku_substring: str | None,
) -> list[AnalysisReturnRow]:
    """当前生效退货原始行（窗口内）—— R2 分子的唯一真相源（BLF-1078）。

    过滤条件与 :func:`query_current_return_rows`（R1 口径唯一真相源）逐字一致：
    只取 ``is_current`` 的 ``return_report`` 源文件下、``return_date`` 落在
    ``[date_from, date_to]`` 的行。

    分子曾经取自 ``analysis_return_aggregates`` 物化表——那是 raw 事实的缓存，
    只为「每日任务处理过的 (SKU, 日)」落行，新入库的历史报表要等下一次刷新才
    可见，于是 R2 会系统性低于 R1/R3（生产实测：铨富 43 vs 66）。改读 raw 后
    三路口径按构造一致。
    """
    conditions = [
        AnalysisReturnRow.project_id == project_id,
        AnalysisReturnRow.country == country,
        AnalysisSourceFile.report_type == "return_report",
        AnalysisSourceFile.is_current.is_(True),
        AnalysisReturnRow.return_date >= date_from,
        AnalysisReturnRow.return_date <= date_to,
    ]
    if sku_substring:
        # Substring match, case-insensitive. Raw rows store SKU verbatim,
        # so we lower() both sides to stay portable across PG / SQLite.
        conditions.append(
            func.lower(AnalysisReturnRow.sku).like(
                f"%{sku_substring.lower()}%"
            )
        )
    return list(
        db.execute(
            select(AnalysisReturnRow)
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
            )
            .where(*conditions)
        )
        .scalars()
        .all()
    )


def _fetch_window_sales_by_sku(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date,
    date_to: date,
    sku_substring: str | None = None,
) -> dict[str, int]:
    """Per-SKU counted sales within the window, straight from the raw
    sales-order layer (same source as R1's ``_build_sales_aggregates``).

    BLF-806: this is the authoritative window-sales denominator. The
    aggregate table only carries rows for (SKU, day) pairs that had
    returns, so summing any aggregate column can never reproduce the
    window's full counted sales — sales-only days would be dropped.
    """
    sales_conditions = [
        counted_sales_where(
            project_id=project_id,
            country=country,
            date_from=date_from,
            date_to=date_to,
        )
    ]
    if sku_substring:
        # 同 :func:`_fetch_window_return_rows`：子串过滤在 SQL 侧大小写归一。
        sales_conditions.append(
            func.lower(AnalysisSalesOrderRow.sku).like(
                f"%{sku_substring.lower()}%"
            )
        )
    rows = db.execute(
        select(
            AnalysisSalesOrderRow.sku,
            func.sum(AnalysisSalesOrderRow.quantity).label("qty"),
        )
        .where(*sales_conditions)
        .group_by(AnalysisSalesOrderRow.sku)
    ).all()
    return {(r.sku or ""): _as_int(r.qty) for r in rows}


def _collapse_to_per_sku(
    records: list[AnalysisReturnRow],
    *,
    window_sales_by_sku: dict[str, int],
    cycle_stats_by_sku: dict[str, dict] | None = None,
) -> list[dict]:
    """Collapse current raw return rows into per-SKU rollups.

    ``records`` come from :func:`_fetch_window_return_rows` (the same source
    and filters as R1/R3); ``window_sales_by_sku`` comes from
    :func:`_fetch_window_sales_by_sku` (raw sales layer).

    For each SKU we:

    * ``return_count`` — number of **unique ``(order_id, sku)`` events within
      the whole window**, matching R1's ``summary.total_returns``. The old
      implementation summed a per-day unique count, which double-counted the
      same order across two return dates and could exceed R1 (犀牛: 188 vs 187).
    * ``return_quantity`` — sum of ``quantity``, matching R1/R3.
    * ``sales_quantity`` — taken verbatim from ``window_sales_by_sku``
      (BLF-806): the window's counted sales for that SKU, identical to
      the R1 overview denominator. (Historic notes: before BLF-806 this
      took ``max`` of a cumulative-through-date column — a full-history
      total that inflated every return_rate; the first BLF-806 attempt
      summed a daily column that only existed on days with returns,
      deflating it instead.)
    * ``cycle_avg_days`` / ``cycle_min_days`` / ``cycle_max_days`` — from
      ``cycle_stats_by_sku`` (raw-derived; previously read off the aggregate
      table, which never populated them — 0/1647 rows in production).
    * ``wilson_lower`` / ``return_rate`` / ``risk_level`` — recomputed from
      the rolled window totals, so agents comparing snapshots over time see a
      value derived from the combined window rather than a noisy per-day pick
      (``risk_level`` follows the same rule as the internal endpoint).
    * ``reason_top1`` / ``disposition_top1`` / ``dominant_fc_id`` — window-wide
      argmax by returned quantity (was: argmax of a single day's row). Ties are
      broken by first appearance in ``return_date`` order, which the source
      query already guarantees deterministically.
    """
    cycle_stats_by_sku = cycle_stats_by_sku or {}
    by_sku: dict[str, dict] = {}
    for r in records:
        sku = r.sku or ""
        agg = by_sku.get(sku)
        if agg is None:
            agg = {
                "sku": sku,
                "return_count_keys": set(),
                "return_quantity": 0,
                "reason_weight": Counter(),
                "disposition_weight": Counter(),
                "fc_weight": Counter(),
            }
            by_sku[sku] = agg
        qty = _as_int(r.quantity)
        agg["return_quantity"] += qty
        agg["return_count_keys"].add((r.order_id, sku))
        if r.reason:
            agg["reason_weight"][r.reason] += qty
        if r.detailed_disposition:
            agg["disposition_weight"][r.detailed_disposition] += qty
        if r.fulfillment_center_id:
            agg["fc_weight"][r.fulfillment_center_id] += qty

    def _top1(counter: Counter) -> str | None:
        return counter.most_common(1)[0][0] if counter else None

    out: list[dict] = []
    for sku, agg in by_sku.items():
        rq = agg["return_quantity"]
        sq = window_sales_by_sku.get(sku, 0)
        # risk_level 从 rolled totals 重算（与 internal endpoint 一致），
        # 不取"worst across daily rows"——逐日行独立判定会漏掉跨日累积的
        # 风险，且窗口口径下分母应以整个窗口为准。
        risk_level, _ = compute_risk_level(rq, sq)
        return_rate = round(rq * 100.0 / sq, 3) if sq > 0 else 0.0
        cycle = cycle_stats_by_sku.get(sku) or {}
        out.append(
            {
                "sku": sku,
                "return_count": len(agg["return_count_keys"]),
                "return_quantity": rq,
                "sales_quantity": sq,
                "return_rate": return_rate,
                "wilson_lower": round(wilson_lower_bound(rq, sq), 3),
                "cycle_avg_days": cycle.get("avg"),
                "cycle_min_days": cycle.get("min"),
                "cycle_max_days": cycle.get("max"),
                "reason_top1": _top1(agg["reason_weight"]),
                "disposition_top1": _top1(agg["disposition_weight"]),
                "dominant_fc_id": _top1(agg["fc_weight"]),
                "risk_level": risk_level,
                # BLF-1078 P2-6：``risk_level == "no_data"`` 表达的是「销量样本
                # 不足以做 Wilson 判定」（sales_quantity < 15），不是「这条
                # SKU 没有退货」——但调用方常用 risk_level 过滤高风险 SKU，
                # 于是退货率极高的长尾单品（生产实例：JTZ-M35-78 200%、
                # SMJ-6x9 53.85%）会被当作「无数据」直接滤掉。这里把
                # 「样本量不足」拆到独立字段，让调用方能在保留原枚举语义的
                # 前提下按 ``confidence`` 判断可信度。
                "confidence": (
                    "low" if sq < MIN_SALES_FOR_RISK_LEVEL else "high"
                ),
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
    per_day = _fetch_window_return_rows(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        sku_substring=sku_substring,
    )
    # BLF-806: 分母取 raw 销售层的窗口 counted sales（与 R1 overview 同源），
    # 而非聚合表行的任何列求和——聚合行只为「有退货的 SKU×日」写入，
    # 对它求和必然漏掉所有无退货的销售日。
    window_sales_by_sku = _fetch_window_sales_by_sku(
        db,
        project_id=project_id,
        country=country,
        date_from=date_from,
        date_to=date_to,
        sku_substring=sku_substring,
    )
    # BLF-1078：周期天（退货日期 - 原单日期）从 raw 销售层现算（R4 同源），
    # 不再依赖聚合表的 cycle_* 列——生产 1647 行全为 NULL，R2 一直返回 null。
    from app.services.analysis.return_analysis.analysis import (
        _build_cycle_days_by_sku,
    )

    cycle_stats_by_sku = _build_cycle_days_by_sku(
        db,
        project_id=project_id,
        country=country,
        records=per_day,
    )
    per_sku = _collapse_to_per_sku(
        per_day,
        window_sales_by_sku=window_sales_by_sku,
        cycle_stats_by_sku=cycle_stats_by_sku,
    )
    # BLF-1078 P0-2：分母必须是窗口全店销量，而不是只有「本期发生过退货的 SKU」
    # 的销量。零退货 SKU 只出现在销售层、不在退货层，所以仅由退货行走过的 SKU
    # 集合永远是最小的那个；R1 overview 用全店销量做分母，两者差就是零退货 SKU
    # 的销量，把 R2 的退货率系统性抬高（生产实测华洋泛航 +2.56pp、犀牛 +0.32pp、
    # 短窗口下整店分母直接塔陷为 0）。这里把只有销售、零退货的 SKU 补回为
    # 「零退货行」，让 R2 的 summary 与 R1 同分母。
    returned_skus = {r["sku"] for r in per_sku}
    for sku, sales_qty in window_sales_by_sku.items():
        if sku in returned_skus or sales_qty <= 0:
            continue
        per_sku.append(
            {
                "sku": sku,
                "return_count": 0,
                "return_quantity": 0,
                "sales_quantity": sales_qty,
                "return_rate": 0.0,
                "wilson_lower": 0.0,
                "cycle_avg_days": None,
                "cycle_min_days": None,
                "cycle_max_days": None,
                "reason_top1": None,
                "disposition_top1": None,
                "dominant_fc_id": None,
                # 零退货但销量 ≥15 → normal；样本不足则 no_data，
                # 与 :func:`_collapse_to_per_sku` 的口径保持一致。
                "risk_level": "normal"
                if sales_qty >= MIN_SALES_FOR_RISK_LEVEL
                else "no_data",
                "confidence": "high"
                if sales_qty >= MIN_SALES_FOR_RISK_LEVEL
                else "low",
            }
        )
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

    BLF-1078 P2-7：本查询补上了 ``is_current`` 过滤（只取当前生效退货报表
    源文件的行），与 :func:`query_current_return_rows` / R1 / R2 完全同口径。

    此前它只按 ``project_id + country + return_date`` 过滤，把已被取代
    （``is_current=False``）的历史报表版本一并返回，于是 R3 行数系统性高于
    R1/R2（生产实测犀牛 230 vs 189、玥涵 58 vs 53、创酷 26 vs 21）。差异全部
    来自被取代版本的行，不是「一笔退货多行明细」——现已证实不需要特殊口径
    解释，三路只是过滤条件不一致。

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
        AnalysisSourceFile.report_type == "return_report",
        AnalysisSourceFile.is_current.is_(True),
    )
    rows = (
        db.execute(
            select(AnalysisReturnRow)
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
            )
            .where(filters)
            .order_by(
                order_column.asc() if order_dir == "asc" else order_column.desc()
            )
            .limit(limit)
            .offset(offset)
        )
        .scalars()
        .all()
    )

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
    total_return_count = sum(_as_int(r.get("return_count")) for r in rows)
    total_return_quantity = sum(_as_int(r.get("return_quantity")) for r in rows)
    total_sales_quantity = sum(_as_int(r.get("sales_quantity")) for r in rows)
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
    "build_aggregate_summary",
    "query_return_analysis_aggregate",
    "query_return_analysis_raw",
]

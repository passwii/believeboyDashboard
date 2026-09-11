"""Ad Analysis Insight adapter — typed slot 组装（BLF-1016）。

数据来源复用既有 ``aggregate_project_data``（销售/广告日序列、活动、
10 类广告报表、项目与 SKU 背景），本模块只负责：

- **裁剪**：slot 有硬上限（单 slot 256KiB / 总 768KiB / 数组 500 项），
  聚合产物必须按域口径截断，并在 payload 里留 ``truncated_sections``
  让模型知道数据不完整（可审计：run detail 的 slots 快照里可见）。
- **新鲜度**：由聚合覆盖率与最新数据日期推导，作为 ``data_freshness``
  显式入 slot，不靠模型猜。
- **缺数**：``missing_data.missing_dimensions`` 列出受控维度 ID。

scope 一致性（``validator._check_scope_consistency``）：run 的
``project_id`` 必须在 ``ad.context.project_ids`` 里、``country`` 必须与
``ad.context.country`` 一致——单项目广告分析天然自洽。
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.services.insight.slot_types import json_safe

#: 广告报表口径下「新鲜」的最大滞后天数（超过即 stale）。
AD_FRESHNESS_MAX_AGE_DAYS = 3

#: 各列表的 slot 裁剪上限（远小于 limits.ARRAY_MAX_ITEMS=500）。
SERIES_MAX_ITEMS = 366
CAMPAIGN_MAX_ITEMS = 60
SKU_MAX_ITEMS = 50
BREAKDOWN_TOP_MAX_ITEMS = 20
SKU_CONTEXT_MAX_ITEMS = 50
OUT_OF_STOCK_MAX_ITEMS = 50


def _cap(rows: Any, limit: int) -> tuple[list[Any], bool]:
    if not isinstance(rows, list):
        return [], False
    return rows[:limit], len(rows) > limit


def _cap_inventory_summary(summary: Any) -> dict[str, Any]:
    if not isinstance(summary, dict):
        return {}
    capped = dict(summary)
    skus, _ = _cap(capped.get("out_of_stock_skus"), OUT_OF_STOCK_MAX_ITEMS)
    if "out_of_stock_skus" in capped:
        capped["out_of_stock_skus"] = skus
    return capped


def _trim_breakdown(breakdown: Any) -> dict[str, dict[str, Any]]:
    """10 类广告报表：逐类截断 ``top`` 列表，保留 ``has_data``/``summary``。"""
    if not isinstance(breakdown, dict):
        return {}
    trimmed: dict[str, dict[str, Any]] = {}
    for report_type, block in breakdown.items():
        if not isinstance(block, dict):
            continue
        entry = {k: v for k, v in block.items() if k != "top"}
        top, _ = _cap(block.get("top"), BREAKDOWN_TOP_MAX_ITEMS)
        entry["top"] = top
        trimmed[str(report_type)] = entry
    return trimmed


def trim_ad_payload(data: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """聚合产物 → slot 载荷（带截断标记）；返回 ``(payload, truncated)``。"""
    truncated: list[str] = []
    payload: dict[str, Any] = {
        "project_name": data.get("project_name") or "",
        "country": data.get("country") or "",
        "date_range_start": data.get("date_range_start"),
        "date_range_end": data.get("date_range_end"),
        "comparison_period": data.get("comparison_period") or {},
        "data_coverage": data.get("data_coverage") or {},
        "inventory_summary": _cap_inventory_summary(data.get("inventory_summary")),
        "ad_breakdown_by_type": _trim_breakdown(data.get("ad_breakdown_by_type")),
    }
    for key, limit in (
        ("sales_by_date", SERIES_MAX_ITEMS),
        ("ad_by_date", SERIES_MAX_ITEMS),
        ("ad_campaigns", CAMPAIGN_MAX_ITEMS),
        ("top_skus", SKU_MAX_ITEMS),
    ):
        rows, cut = _cap(data.get(key), limit)
        payload[key] = rows
        if cut:
            truncated.append(key)

    project_context = data.get("project_context")
    if isinstance(project_context, dict) and project_context:
        payload["project_context"] = project_context
    sku_context = data.get("sku_context")
    if isinstance(sku_context, dict) and sku_context:
        capped_context = dict(sku_context)
        skus, _ = _cap(capped_context.get("skus"), SKU_CONTEXT_MAX_ITEMS)
        if "skus" in capped_context:
            capped_context["skus"] = skus
        payload["sku_context"] = capped_context

    if truncated:
        payload["truncated_sections"] = truncated
    return payload, truncated


def _latest_series_date(data: dict[str, Any]) -> date | None:
    """日序列里最新的数据日期（两个序列取 max）；无数据返回 None。"""
    latest: date | None = None
    for key in ("sales_by_date", "ad_by_date"):
        rows = data.get(key)
        if not isinstance(rows, list):
            continue
        for row in rows:
            raw = row.get("date") if isinstance(row, dict) else None
            if not raw:
                continue
            try:
                parsed = date.fromisoformat(str(raw)[:10])
            except ValueError:
                continue
            if latest is None or parsed > latest:
                latest = parsed
    return latest


def assess_freshness(data: dict[str, Any], *, today: date) -> dict[str, Any]:
    """聚合产物 → ``data_freshness`` slot。

    覆盖率口径与 ``aggregate_project_data`` 的 ``data_coverage`` 一致：
    ``<total_requested_days`` 视为 stale（报告缺日）；完全没有数据视为
    missing；覆盖率不可判定时 unknown。
    """
    coverage = data.get("data_coverage")
    if not isinstance(coverage, dict):
        coverage = {}
    total = int(coverage.get("total_requested_days") or 0)
    covered = max(
        int(coverage.get("sales_days") or 0),
        int(coverage.get("ad_days") or 0),
    )
    as_of = _latest_series_date(data)
    age_days = (today - as_of).days if as_of is not None else None
    if not total:
        status = "unknown"
    elif covered == 0:
        status = "missing"
    elif covered < total or age_days is None or age_days > AD_FRESHNESS_MAX_AGE_DAYS:
        status = "stale"
    else:
        status = "fresh"
    return {
        "status": status,
        "as_of": as_of.isoformat() if as_of is not None else None,
        "age_days": age_days,
        "source": "ad_reports",
    }


def assess_missing(data: dict[str, Any]) -> dict[str, Any]:
    """聚合产物 → ``missing_data`` slot（受控维度 ID）。"""
    coverage = data.get("data_coverage")
    if not isinstance(coverage, dict):
        coverage = {}
    missing: list[str] = []
    if not int(coverage.get("sales_days") or 0):
        missing.append("sales_series")
    if not int(coverage.get("ad_days") or 0):
        missing.append("ad_series")
    if not data.get("ad_campaigns"):
        missing.append("ad_campaigns")
    breakdown = data.get("ad_breakdown_by_type")
    if not isinstance(breakdown, dict) or not any(
        isinstance(block, dict) and block.get("has_data") for block in breakdown.values()
    ):
        missing.append("ad_breakdown")
    if not data.get("top_skus"):
        missing.append("top_skus")
    return {"is_complete": not missing, "missing_dimensions": missing}


def ad_context_slot(
    *,
    project_id: int,
    project_name: str,
    country: str,
    date_range_start: date,
    date_range_end: date,
    data_freshness: dict[str, Any],
    missing_data: dict[str, Any],
) -> dict[str, Any]:
    """``ad.context``：范围、口径、新鲜度与缺数（validator 校验 scope 一致）。"""
    return {
        "slot_version": 1,
        "date_range_start": date_range_start.isoformat(),
        "date_range_end": date_range_end.isoformat(),
        "project_ids": [project_id],
        "country": country,
        "data_freshness": data_freshness,
        "missing_data": missing_data,
        "project_name": project_name,
    }


def ad_data_slot(payload: dict[str, Any]) -> dict[str, Any]:
    """``ad.data``：裁剪后的聚合产物（真实 JSON 对象，非字符串化）。

    ``json_safe`` 消除聚合产物里可能混入的 date/Decimal——slot 会被
    ``json.dumps`` 落库并原样进 prompt，非 JSON 原生类型在契约层就会炸。
    """
    return {"slot_version": 1, "encoding": "json", "payload": json_safe(payload)}


def build_ad_slots(
    db: Any,
    *,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    today: date | None = None,
    progress_cb: Any = None,
) -> dict[str, Any] | None:
    """聚合 → 完整 slots；项目不存在时返回 None（调用方按 404 处理）。

    注意：``aggregate_project_data`` 内部自开读会话（可路由只读副本），
    因此 slots 必须在**请求侧**组装完成后才提交 run——run 落库的
    ``slots_json`` 是这棵已冻结的载荷，worker 侧不再回查业务表。
    """
    from app.services.ai_insight_aggregator import aggregate_project_data

    aggregated = aggregate_project_data(
        db, project_id, country, start_date, end_date, progress_cb
    )
    if aggregated is None:
        return None
    data = aggregated.to_dict()
    payload, _ = trim_ad_payload(data)
    reference = today or date.today()
    return {
        "ad.context": ad_context_slot(
            project_id=project_id,
            project_name=str(data.get("project_name") or ""),
            country=country,
            date_range_start=start_date,
            date_range_end=end_date,
            data_freshness=assess_freshness(data, today=reference),
            missing_data=assess_missing(data),
        ),
        "ad.data": ad_data_slot(payload),
    }


__all__ = [
    "AD_FRESHNESS_MAX_AGE_DAYS",
    "ad_context_slot",
    "ad_data_slot",
    "assess_freshness",
    "assess_missing",
    "build_ad_slots",
    "trim_ad_payload",
]

"""Inventory Health Insight adapter — typed slot 组装（BLF-1016）。

数据来源复用既有确定性补货分析 ``list_inventory_replenishment_analysis``
（SKU 行 + 全量 summary + 三段式 state/action 分布），本模块只负责：

- **裁剪**：单 slot 上限 256KiB（``limits.SLOT_CANONICAL_MAX_BYTES``）。
  summary 覆盖**全量** SKU（服务侧在分页前统计），行只取最紧急的
  ``ROW_MAX_ITEMS`` 条（按 ``sellable_days`` 升序），并把 ``total`` 与
  ``truncated`` 写进 payload——模型据此知道列表是部分数据。
- **新鲜度**：快照锚点显式区分「无快照」（missing）与「快照就是今天」
  （fresh）；阈值与 ``state_action.compute_signals`` 的置信度口径对齐
  （> 1 天 medium、> 3 天 low）。实时路径（``report_date=None``）取
  ``current_inventory_snapshot_report_date``（与数据加载器同一查询），
  历史路径取 ``latest_inventory_snapshot_date``；锚点晚于参照日报
  ``unknown`` 而非 `fresh`（复审[7]）。
- **口径日**：参照日在 ``build_inventory_slots`` 内只读一次挂钟，
  ``report_date or reference_today`` 同时是 slot 声明的口径日、service
  的 DMS 窗口基准与新鲜度基准。
- **缺数**：``missing_data.missing_dimensions`` 列出受控维度 ID。

scope 一致性（``validator._check_scope_consistency``）：run 的
``project_id`` 必须出现在 ``inventory.context.project_ids``、``country``
必须与 ``inventory.context.country`` 相等。
"""

from __future__ import annotations

from datetime import date
from typing import Any

from app.services.insight.slot_types import json_safe
from app.utils.country import normalize_country

#: 快照滞后超过该天数即 stale（对齐 ``state_action``：> 1 天置信度降为
#: medium、> 3 天为 low；两者都意味着快照不是当天口径）。
INVENTORY_FRESH_MAX_AGE_DAYS = 1

#: 行裁剪上限（与 R1 列表端点 page_size 上限一致）。
ROW_MAX_ITEMS = 200

#: summary 里随 slot 走的计数键（全量口径，不受行裁剪影响）。
_SUMMARY_KEYS = (
    "sku_count",
    "out_of_stock_risk_count",
    "healthy_count",
    "slow_moving_count",
    "pending_data_count",
    "total_available_inventory",
    "total_in_transit_quantity",
    "critical_count",
    "deteriorating_count",
    "watch_count",
    "healthy_count_v2",
    "unknown_count",
    "state_distribution",
    "action_distribution",
)


def trim_summary(summary: Any) -> dict[str, Any]:
    """summary → slot 载荷：只保留计数/分布（state×action 矩阵太大）。"""
    if not isinstance(summary, dict):
        return {}
    return {key: summary[key] for key in _SUMMARY_KEYS if key in summary}


def normalize_inventory_country(country: str) -> str:
    """站点归一（``US``/``USA``/``美国`` → ``US``）。

    canonical run 的 ``country`` 由 ``schemas.insight.CountryCode`` 限定为
    US/DE/UK，故对合法输入这是恒等变换；此处只保证与 R1 列表服务使用
    同一套归一，避免 slot 里的站点与 SQL 过滤口径不一致。
    """
    return normalize_country(country, default="US")


def assess_freshness(
    snapshot_report_date: date | None, *, today: date
) -> dict[str, Any]:
    """快照日期 → ``data_freshness`` slot（缺失与新鲜必须可区分）。

    锚点晚于参照日（实时路径拿到日期在未来/时钟偏移的快照文件）既不能说
    「新鲜」也不能说「陈旧」：报 ``unknown`` + ``age_days=0``，但 ``as_of``
    照实输出，审计要能看到锚点究竟是什么。裸 ``max(0, ...)`` 会把异常伪装成
    「今天的数据」（复审[7]）。
    """
    if snapshot_report_date is None:
        return {
            "status": "missing",
            "as_of": None,
            "age_days": None,
            "source": "inventory_report",
        }
    if snapshot_report_date > today:
        return {
            "status": "unknown",
            "as_of": snapshot_report_date.isoformat(),
            "age_days": 0,
            "source": "inventory_report",
        }
    age_days = (today - snapshot_report_date).days
    status = "stale" if age_days > INVENTORY_FRESH_MAX_AGE_DAYS else "fresh"
    return {
        "status": status,
        "as_of": snapshot_report_date.isoformat(),
        "age_days": age_days,
        "source": "inventory_report",
    }


def assess_missing(
    *,
    snapshot_report_date: date | None,
    summary: dict[str, Any],
    rows: list[dict[str, Any]],
) -> dict[str, Any]:
    """缺数维度（受控 ID）：快照、SKU、DMS、库龄、在途。"""
    missing: list[str] = []
    if snapshot_report_date is None:
        missing.append("snapshot")
    if not rows:
        missing.append("skus")
    counts = summary if isinstance(summary, dict) else {}
    sku_count = int(counts.get("sku_count") or 0)
    pending = int(counts.get("pending_data_count") or 0)
    if sku_count and pending >= sku_count:
        missing.append("dms")
    if not sku_count or int(counts.get("total_available_inventory") or 0) == 0:
        missing.append("aging")
    if int(counts.get("total_in_transit_quantity") or 0) == 0:
        missing.append("in_transit")
    return {"is_complete": not missing, "missing_dimensions": missing}


def trim_rows(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    """SKU 行裁剪：按 ``sellable_days`` 升序取最紧急的 N 条。

    ``None``（无 DMS，无法判断）排在最后——先看有明确风险的 SKU。
    """

    def sort_key(row: dict[str, Any]) -> tuple[int, float]:
        value = row.get("sellable_days")
        if value is None:
            return (1, 0.0)
        try:
            return (0, float(value))
        except (TypeError, ValueError):
            return (1, 0.0)

    ordered = sorted(rows, key=sort_key)
    return ordered[:ROW_MAX_ITEMS], len(ordered) > ROW_MAX_ITEMS


def inventory_context_slot(
    *,
    project_id: int,
    project_name: str,
    country: str,
    report_date: date,
    data_freshness: dict[str, Any],
    missing_data: dict[str, Any],
) -> dict[str, Any]:
    """``inventory.context``：口径日期、站点、新鲜度与缺数。"""
    return {
        "slot_version": 1,
        "report_date": report_date.isoformat(),
        "project_ids": [project_id],
        "country": country,
        "data_freshness": data_freshness,
        "missing_data": missing_data,
        "project_name": project_name,
    }


def inventory_data_slot(payload: dict[str, Any]) -> dict[str, Any]:
    """``inventory.data``：确定性分析产物（真实 JSON 对象，非字符串化）。

    补货分析的 SKU 行里带 ``date``（sellout/risk_anchor/coverage_end…），
    ``json_safe`` 统一转 ISO——slot 要 ``json.dumps`` 落库并原样进 prompt。
    """
    return {"slot_version": 1, "encoding": "json", "payload": json_safe(payload)}


def build_inventory_slots(
    db: Any,
    *,
    project_id: int,
    country: str,
    report_date: date | None = None,
    today: date | None = None,
) -> dict[str, Any] | None:
    """确定性分析 → 完整 slots；项目不存在时返回 None（调用方按 404 处理）。

    slots 必须在**请求侧**组装完成后才提交 run：worker 只消费 run 落库的
    ``slots_json``，不再回查业务表（与 schedule/adapter 同口径）。

    口径日契约（复审[7]）——参照日只在**这里**读一次挂钟：

    - ``report_date`` 有值：口径日 = ``report_date``；查询按 ``<= report_date``
      过滤，数据锚点 = 该过滤选中的快照日。
    - ``report_date is None``（实时路径）：口径日 = ``today``（缺省才回落到
      ``date.today()``）。查询**不带日期上界**以保留实时在途 ETA 时间线
      （BLF-630），因此数据锚点就是「最新一份快照文件」的日期——它由
      ``current_inventory_snapshot_report_date`` 用**与数据加载器同一个**
      查询给出，不是另起一条有上界的查询，故
      ``payload.report_date``（= ``context.report_date``）声明口径日、
      ``payload.snapshot_report_date``（= ``data_freshness.as_of``）声明
      数据实际来源，四者不会再漂移。
    """
    from app.models.project import Project
    from app.services.inventory.replenishment import (
        current_inventory_snapshot_report_date,
        latest_inventory_snapshot_date,
        list_inventory_replenishment_analysis,
    )

    project = db.get(Project, project_id)
    if project is None:
        return None

    normalized_country = normalize_inventory_country(country)
    # 参照日只读一次：口径日与新鲜度基准必须是同一个「今天」，否则跨午夜
    # 时 slot 会自称某天、却按另一天算 age（复审[7]）。
    reference_today = today or date.today()
    anchor_date = report_date or reference_today
    project_name = project.project_name or ""

    rows, summary, total, _has_next = list_inventory_replenishment_analysis(
        db,
        project_id=project_id,
        country=normalized_country,
        keyword=None,
        risk_status=None,
        in_transit_only=False,
        page=1,
        page_size=ROW_MAX_ITEMS,
        report_date=report_date,
        # 排序必须由**服务端在全量行上**完成：只取前 N 条再本地排序，会把
        # 最紧急的 SKU 留在后面几页（复审[2]）。白名单与 R1 列表同一套
        # （``sellable_days``，None 恒排后）；``trim_rows`` 只作确定性兜底。
        order_by="sellable_days",
        order_dir="asc",
        # service 不得自己再读挂钟：DMS 窗口与快照年龄锚在同一个参照日。
        today=reference_today,
    )
    if report_date is None:
        # 实时路径：锚点 = 数据加载器实际选中的那份快照文件的日期。
        snapshot_report_date = current_inventory_snapshot_report_date(
            db, project_id, normalized_country
        )
    else:
        # 历史路径：锚点 = 该口径日下 ``_get_inventory_source`` 会选中的快照日。
        snapshot_report_date = latest_inventory_snapshot_date(
            db, project_id, normalized_country, anchor_date
        )
    trimmed_rows, rows_truncated = trim_rows(rows)
    summary_payload = trim_summary(summary)
    payload: dict[str, Any] = {
        "project_name": project_name,
        "country": normalized_country,
        "report_date": anchor_date.isoformat(),
        "snapshot_report_date": (
            snapshot_report_date.isoformat() if snapshot_report_date else None
        ),
        "summary": summary_payload,
        "rows": trimmed_rows,
        "row_total": total,
        "rows_truncated": rows_truncated or len(rows) < total,
        "row_limit": ROW_MAX_ITEMS,
    }
    return {
        "inventory.context": inventory_context_slot(
            project_id=project_id,
            project_name=project_name,
            country=normalized_country,
            report_date=anchor_date,
            data_freshness=assess_freshness(
                snapshot_report_date, today=reference_today
            ),
            missing_data=assess_missing(
                snapshot_report_date=snapshot_report_date,
                summary=summary_payload,
                rows=trimmed_rows,
            ),
        ),
        "inventory.data": inventory_data_slot(payload),
    }


__all__ = [
    "INVENTORY_FRESH_MAX_AGE_DAYS",
    "ROW_MAX_ITEMS",
    "assess_freshness",
    "assess_missing",
    "build_inventory_slots",
    "inventory_context_slot",
    "inventory_data_slot",
    "normalize_inventory_country",
    "trim_rows",
    "trim_summary",
]

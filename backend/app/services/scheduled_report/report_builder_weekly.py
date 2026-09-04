"""Build weekly report data structure with natural week calculation.

Uses natural weeks (Monday-Sunday) instead of rolling 7-day periods.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    AdUploadFile,
    AdUploadPromotedProductRow,
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.models.project import Project
from app.models.sku_info import SkuRecord
from app.utils.math_utils import change_pct
from app.utils.sales_amount import sales_amount_expr
from app.services.scheduled_report.context_helpers import (
    fetch_and_format_sku_factory_info,
    fetch_multi_project_context,
)
from app.utils.country import get_today_for_country, normalize_country

from .ai_enhancer_weekly import (
    detect_weekly_anomalies,
    generate_weekly_action_items,
    generate_weekly_alert_insights,
    generate_weekly_ai_summary,
    generate_weekly_attribution_analysis,
)

logger = logging.getLogger(__name__)


def _get_previous_natural_week(reference_date: date) -> tuple[date, date]:
    """计算参考日期所在周的上一个完整自然周（周一到周日）。
    
    示例：
      reference_date = 2026-05-22 (周五)
      → 所在周周一 = 2026-05-18
      → 上周周一 = 2026-05-11
      → 上周周日 = 2026-05-17
    """
    days_since_monday = reference_date.weekday()
    current_week_monday = reference_date - timedelta(days=days_since_monday)
    prev_week_monday = current_week_monday - timedelta(days=7)
    prev_week_sunday = current_week_monday - timedelta(days=1)
    return prev_week_monday, prev_week_sunday


def _get_prev_prev_natural_week(prev_week_monday: date) -> tuple[date, date]:
    """计算上上周的日期范围。"""
    prev_prev_monday = prev_week_monday - timedelta(days=7)
    prev_prev_sunday = prev_week_monday - timedelta(days=1)
    return prev_prev_monday, prev_prev_sunday


def _get_report_anchor_date(country: str) -> date:
    """计算报告的数据锚定日期 — 最近一个数据完整的日期。"""
    country_today = get_today_for_country(country)
    server_yesterday = date.today() - timedelta(days=1)
    return min(country_today, server_yesterday)


def _calc_change_pct(current: float, prev: float) -> float | None:
    """计算变化百分比（统一走 ``math_utils.change_pct``，BLF-570）。

    prev <= 0 且 current > 0 时返回 ``None``（上期无基数，变化率无意义），
    消费方需按 ``or 0`` / "—" 兜底；两期均无数据时返回 0.0。
    """
    return change_pct(current, prev)


def _format_date_range(start: date, end: date) -> str:
    """格式化日期范围为中文描述。"""
    return f"{start.month}月{start.day}日 - {end.month}月{end.day}日"


def _resolve_project_name(db: Session, project_ids: list[int] | None) -> str:
    """根据 project_ids 从数据库查询实际项目名称。

    - project_ids 为 None 或空列表 → "全部项目"
    - 单个/多个 → 逗号分隔的真实项目名
    """
    if not project_ids:
        return "全部项目"
    names = (
        db.query(Project.project_name)
        .filter(Project.id.in_(project_ids))
        .order_by(Project.id)
        .all()
    )
    if not names:
        return "全部项目"
    return ", ".join(n[0] for n in names)


def build_weekly_report_data(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    project_name: str | None = None,
    reference_date: date | None = None,
    stage_callback=None,
    ai_timeout: float | None = None,
    generate_ai_summary: bool = True,
) -> dict[str, Any]:
    """构建完整的周报告数据结构。

    使用自然周计算：
    - 上周：上一个完整的自然周（周一到周日）
    - 上上周：再往前一周

    Args:
        db: 数据库会话
        project_ids: 项目 ID 列表，None 表示全部项目
        country: 国家代码
        project_name: 项目名称覆盖（不传则从数据库自动解析）
        reference_date: 补发时指定的数据锚定日期。为 None 时自动计算。
        ai_timeout: AI 摘要生成的最大等待秒数，None 使用默认值

    Returns:
        完整的周报告数据字典
    """
    # 自动解析项目名称
    if project_name is None:
        project_name = _resolve_project_name(db, project_ids)
    # 锚定日期：补发时使用指定的历史日期，正常调度时自动计算
    anchor_date = reference_date if reference_date is not None else _get_report_anchor_date(country)
    
    # 使用自然周（上一完整周 vs 上上一完整周）
    prev_week_start, prev_week_end = _get_previous_natural_week(anchor_date)
    prev_prev_week_start, prev_prev_week_end = _get_prev_prev_natural_week(prev_week_start)
    
    # 1. 获取上周和上上周的销售数据
    current_week = _aggregate_weekly_sales(db, project_ids, country, prev_week_start, prev_week_end)
    prev_week = _aggregate_weekly_sales(db, project_ids, country, prev_prev_week_start, prev_prev_week_end)
    
    # 2. 计算变化率
    changes = {
        "qty_change": _calc_change_pct(current_week["qty"], prev_week["qty"]),
        "amount_change": _calc_change_pct(current_week["amount"], prev_week["amount"]),
        "orders_change": _calc_change_pct(current_week["qty"], prev_week["qty"]),
        "avg_price_change": _calc_change_pct(current_week["avg_price"], prev_week["avg_price"]),
    }
    
    # 3. SKU 归因分析
    attribution = _analyze_sku_attribution(
        db, project_ids, country,
        prev_week_start, prev_week_end,
        prev_prev_week_start, prev_prev_week_end,
    )
    
    # 4. Top SKU 上周 vs 上上周对比
    top_skus_comparison = _get_top_skus_with_comparison(
        db, project_ids, country,
        prev_week_start, prev_week_end,
        prev_prev_week_start, prev_prev_week_end,
        limit=10,
    )
    
    # 5. 库存预警
    inventory_alerts = _get_inventory_alerts(db, project_ids, country)

    # 5.5 库存摘要（用于邮件模板"📦 库存状态"卡片，BEL-131）
    inventory_summary = _get_inventory_summary(db, project_ids, country)
    
    # 6. 广告数据对比
    ads_comparison = _get_ads_comparison(
        db, project_ids, country,
        prev_week_start, prev_week_end,
        prev_prev_week_start, prev_prev_week_end,
        curr_sales_total=current_week.get("amount", 0.0),
        prev_sales_total=prev_week.get("amount", 0.0),
    )
    
    # 7. 退货数据（需要周总销量算退货率）
    returns_data = _get_weekly_returns(db, project_ids, country, prev_week_start, prev_week_end, current_week.get("qty", 0))

    # 7.5 上周每日销量趋势（周一到周日逐日拆分）
    daily_trend = _get_daily_sales_trend(db, project_ids, country, prev_week_start, prev_week_end)

    # 7.6 SKU 销售明细（本周期，含品名）
    sku_sales_detail = _query_sku_sales_detail(db, project_ids, country, prev_week_start, prev_week_end)

    # 7.7 获取项目背景和 SKU 工厂信息
    project_context, sku_context = fetch_multi_project_context(db, project_ids)
    top_sku_names = [s.get("sku") for s in top_skus_comparison[:8] if s.get("sku")]
    alert_sku_names = [a.get("sku") for a in inventory_alerts[:5] if a.get("sku")]
    relevant_skus = list(dict.fromkeys(top_sku_names + alert_sku_names))
    sku_factory_info_text = fetch_and_format_sku_factory_info(db, relevant_skus, country, project_ids)

    # 8. 检测预警信号
    anomalies = detect_weekly_anomalies(
        current_week, prev_week, ads_comparison, returns_data
    )
    
    # 9. 构建预警列表
    alerts = _build_alerts_from_anomalies(anomalies)
    alerts.extend(_build_inventory_alerts(inventory_alerts))
    alerts.extend(_build_positive_signals(top_skus_comparison, ads_comparison))
    
    # 10. 生成 AI 摘要和归因分析
    ai_summary = ""
    if generate_ai_summary:
        # 通知调度器：数据获取完成，开始生成 AI 摘要
        if stage_callback:
            from app.models.scheduled_report import DeliveryStage
            stage_callback(DeliveryStage.GENERATING_SUMMARY.value)

        ai_summary = generate_weekly_ai_summary({
            "current_week": current_week,
            "prev_week": prev_week,
            "changes": changes,
            "attribution": attribution,
            "alerts": alerts,
            "top_skus_comparison": top_skus_comparison,
            "ads_comparison": ads_comparison,
            "inventory_alerts": inventory_alerts,
            "inventory_summary": inventory_summary,
            "anomalies": anomalies,
            "returns_data": returns_data,
            "project_context": project_context,
            "sku_context": sku_context,
            "sku_factory_info_text": sku_factory_info_text,
        }, timeout=ai_timeout)
    
    attribution_summary = generate_weekly_attribution_analysis({
        "attribution": attribution,
        "current_week": current_week,
        "prev_week": prev_week,
    }) if generate_ai_summary else ""
    
    alert_insights = generate_weekly_alert_insights({"alerts": alerts})
    action_items = generate_weekly_action_items({
        "alerts": alerts,
        "attribution": attribution,
        "inventory_alerts": inventory_alerts,
    })
    
    # 计算周数
    week_number = prev_week_start.isocalendar()[1]
    
    return {
        # 基本信息
        "project_name": project_name,
        "country": country,
        "week_number": week_number,
        "date_range": _format_date_range(prev_week_start, prev_week_end),
        "report_date": anchor_date.isoformat(),
        "report_date_end": prev_week_end.isoformat(),
        "prev_week_range": _format_date_range(prev_prev_week_start, prev_prev_week_end),
        
        # 上周 vs 上上周
        "current_week": current_week,
        "prev_week": prev_week,
        "changes": changes,
        
        # 归因分析
        "attribution": attribution,
        "attribution_summary": attribution_summary,
        
        # Top SKU 对比
        "top_skus_comparison": top_skus_comparison,
        
        # 预警信号
        "alerts": alerts,
        "alert_insights": alert_insights,
        
        # 行动建议
        "action_items": action_items,
        
        # 广告对比
        "ads_comparison": ads_comparison,
        
        # 库存预警
        "inventory_alerts": inventory_alerts,

        # 库存摘要（BEL-131：供邮件模板"📦 库存状态"卡片消费）
        "inventory_summary": inventory_summary,
        
        # 退货数据
        "returns_data": returns_data,

        # 上周每日销量趋势
        "daily_trend": daily_trend,

        # SKU 销售明细
        "sku_sales_detail": sku_sales_detail,

        # 项目背景（供邮件模板未来使用）
        "project_context": project_context,
        "sku_context": sku_context,

        # AI 生成内容
        "ai_summary": ai_summary,
        
        # 仪表板链接
        "dash_url": "https://dash.believeboy.com/dashboard",
    }


def _aggregate_weekly_sales(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """聚合指定日期范围的销售数据。"""
    try:
        query = (
            db.query(
                func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
                func.coalesce(func.sum(
                    sales_amount_expr(country)
                ), 0).label("amount"),
                func.count(func.distinct(AnalysisSalesOrderRow.purchase_date_pt)).label("active_days"),
            )
            # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current）。
            .filter(
                AnalysisSalesOrderRow.country == country,
                AnalysisSalesOrderRow.is_counted_sales.is_(True),  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSalesOrderRow.project_id.in_(project_ids))

        row = query.first()
        
        qty = int(row.qty) if row and row.qty else 0
        amount = float(row.amount) if row and row.amount else 0.0
        orders = qty  # 简化处理
        avg_price = amount / qty if qty > 0 else 0.0
        
        return {
            "qty": qty,
            "amount": amount,
            "orders": orders,
            "avg_price": avg_price,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        }
    except Exception as e:
        logger.warning(f"Failed to aggregate weekly sales: {e}")
        return {
            "qty": 0,
            "amount": 0.0,
            "orders": 0,
            "avg_price": 0.0,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
        }


def _analyze_sku_attribution(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date,
    curr_end: date,
    prev_start: date,
    prev_end: date,
) -> list[dict[str, Any]]:
    """分析 SKU 对销售变化的贡献。"""
    try:
        from sqlalchemy import case
        
        all_skus_query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("curr_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(prev_start, prev_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("prev_qty"),
            )
            # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current）。
            .filter(
                AnalysisSalesOrderRow.country == country,
            )
        )
        if project_ids:
            all_skus_query = all_skus_query.filter(AnalysisSalesOrderRow.project_id.in_(project_ids))

        results = all_skus_query.group_by(AnalysisSalesOrderRow.sku).all()

        total_curr = sum(int(r.curr_qty or 0) for r in results)
        total_prev = sum(int(r.prev_qty or 0) for r in results)
        total_change = total_curr - total_prev

        attribution = []
        for r in results:
            sku = r.sku or "Unknown"
            curr_qty = int(r.curr_qty or 0)
            prev_qty = int(r.prev_qty or 0)
            change = curr_qty - prev_qty
            pct = (change / total_change * 100) if total_change != 0 else 0
            
            if change > 0:
                change_type = "positive"
            elif change < 0:
                change_type = "negative"
            else:
                change_type = "neutral"
            
            change_rate = _calc_change_pct(curr_qty, prev_qty)
            
            attribution.append({
                "sku": sku,
                "current_qty": curr_qty,
                "prev_qty": prev_qty,
                "contribution": change,
                "pct": round(pct, 1),
                "type": change_type,
                "change_rate": round(change_rate or 0, 1),
            })

        attribution.sort(key=lambda x: x["contribution"], reverse=True)
        return attribution[:15]

    except Exception as e:
        logger.warning(f"Failed to analyze SKU attribution: {e}")
        return []


def _get_top_skus_with_comparison(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date,
    curr_end: date,
    prev_start: date,
    prev_end: date,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """获取 Top SKU 上周和上上周的对比数据。"""
    try:
        from sqlalchemy import case
        
        query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("current_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(prev_start, prev_end), AnalysisSalesOrderRow.quantity),
                        else_=0,
                    )
                ).label("prev_qty"),
                func.sum(
                    case(
                        (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end),
                         sales_amount_expr(country)),
                        else_=0,
                    )
                ).label("current_amount"),
            )
            # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current）。
            .filter(
                AnalysisSalesOrderRow.country == country,
                AnalysisSalesOrderRow.is_counted_sales.is_(True),  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt.between(prev_start, curr_end),
            )
        )
        if project_ids:
            query = query.filter(AnalysisSalesOrderRow.project_id.in_(project_ids))

        results = (
            query.group_by(AnalysisSalesOrderRow.sku)
            .order_by(func.sum(
                case(
                    (AnalysisSalesOrderRow.purchase_date_pt.between(curr_start, curr_end), AnalysisSalesOrderRow.quantity),
                    else_=0,
                )
            ).desc())
            .limit(limit)
            .all()
        )

        top_skus = []
        for r in results:
            current = int(r.current_qty or 0)
            prev = int(r.prev_qty or 0)
            change_rate = _calc_change_pct(current, prev)
            is_new = prev == 0 and current > 0
            
            top_skus.append({
                "sku": r.sku or "Unknown",
                "current": current,
                "prev": prev,
                # BLF-570: 上期无基数（新品）时透传 None，模板渲染 "—" + NEW，
                # 不再显示误导性的 "持平"（与 changes 顶层字段语义一致）
                "change": None if change_rate is None else round(change_rate, 1),
                "amount": float(r.current_amount or 0),
                "new": is_new,
            })

        return top_skus

    except Exception as e:
        logger.warning(f"Failed to get top SKUs with comparison: {e}")
        return []


def _get_inventory_alerts(
    db: Session,
    project_ids: list[int] | None,
    country: str,
) -> list[dict[str, Any]]:
    """获取库存预警 SKU。

    改动（BEL-130）：不再过滤 ``is_current=True``，改为按
    ``(project, country)`` 下 report_date 最新的 inventory 快照取数，
    与库存分析页 ``inventory_analysis_service._get_inventory_source``
    口径保持一致。这样能正确处理 BEL-104 修复前的旧快照（``is_current=False``）
    和手工回填的快照，避免周报里库存数据全部为 0。

    实现说明：latest-per-group 走 ``ROW_NUMBER() OVER (PARTITION BY
    project_id ORDER BY report_date DESC, version DESC, id DESC)`` +
    ``WHERE rn = 1`` 的窗口函数写法，而不是 PG-only 的 ``DISTINCT ON``，
    以保证单元测试在 SQLite 跑得动、生产 PG 也兼容。
    """
    try:
        rn = func.row_number().over(
            partition_by=AnalysisSourceFile.project_id,
            order_by=(
                AnalysisSourceFile.report_date.desc(),
                AnalysisSourceFile.version.desc(),
                AnalysisSourceFile.id.desc(),
            ),
        ).label("rn")
        ranked_subq = (
            db.query(
                AnalysisSourceFile.id.label("source_file_id"),
                AnalysisSourceFile.project_id,
                rn,
            )
            .filter(
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_date.isnot(None),
            )
            .subquery()
        )
        latest_source_subq = db.query(ranked_subq).filter(ranked_subq.c.rn == 1).subquery()

        base_query = (
            db.query(
                InventorySnapshotRow.sku,
                InventorySnapshotRow.available_qty,
                InventorySnapshotRow.stock_status,
            )
            .join(
                latest_source_subq,
                latest_source_subq.c.source_file_id == InventorySnapshotRow.source_file_id,
            )
        )
        if project_ids:
            base_query = base_query.filter(latest_source_subq.c.project_id.in_(project_ids))

        alerts: list[dict[str, Any]] = []
        for row in base_query.filter(
            InventorySnapshotRow.available_qty <= 10
        ).order_by(
            InventorySnapshotRow.available_qty.asc()
        ).limit(20).all():
            if row.available_qty <= 0 or row.stock_status == "out_of_stock":
                alerts.append({
                    "sku": row.sku or "Unknown",
                    "available_qty": int(row.available_qty or 0),
                    "level": "oos",
                })
            else:
                alerts.append({
                    "sku": row.sku or "Unknown",
                    "available_qty": int(row.available_qty or 0),
                    "level": "low",
                })

        if not alerts:
            logger.warning(
                "BEL-130: no inventory alerts found for projects=%s country=%s "
                "— check that at least one inventory_report snapshot is uploaded "
                "for the project/country combination.",
                project_ids,
                country,
            )
        return alerts

    except Exception as e:
        logger.warning(f"Failed to get inventory alerts: {e}")
        return []


def _get_inventory_summary(
    db: Session,
    project_ids: list[int] | None,
    country: str,
) -> dict[str, Any]:
    """库存摘要：用于邮件模板的"📦 库存状态"卡片。

    修复 BEL-131：周报邮件模板的"退货及库存概况"区块（见
    ``email_sender_weekly._section_week_returns`` 与
    ``_render_weekly_content_sections``）会去 ``report_data`` 里读
    ``inventory_summary``，期望拿到 ``{sku_count, total_available,
    low_stock_count, oos_count}`` 四个字段。但
    ``build_weekly_report_data`` 之前只构造了 ``inventory_alerts``
    （告警 list），从未生成这个 summary dict，导致邮件渲染时
    ``inv_total=0``，整段"退货及库存概况"在没有退货的周被直接跳过
    （条件 ``ret_qty>0 or inv_total>0 or ...`` 永不成立），有退货的
    周则四行全显示 0。

    修复：
      * 取数口径与 ``_get_inventory_alerts``（BEL-130）保持一致——
        按 ``(project, country)`` 下 ``report_date`` 最新的 inventory
        快照取数，latest-per-group 走 ``ROW_NUMBER() OVER (...)``
        窗口函数，避免依赖 ``is_current`` 标志。
      * 阈值与月报 ``_get_inventory_summary`` 对齐：``low`` 阈值 = 20，
        ``oos`` 阈值 = ``available_qty <= 0`` 或
        ``stock_status == 'out_of_stock'``。

    Args:
        db: 数据库会话
        project_ids: 项目 ID 列表，None 表示全部项目
        country: 国家代码

    Returns:
        ``{"sku_count": int, "total_available": int,
           "low_stock_count": int, "oos_count": int}``
    """
    try:
        rn = func.row_number().over(
            partition_by=AnalysisSourceFile.project_id,
            order_by=(
                AnalysisSourceFile.report_date.desc(),
                AnalysisSourceFile.version.desc(),
                AnalysisSourceFile.id.desc(),
            ),
        ).label("rn")
        ranked_subq = (
            db.query(
                AnalysisSourceFile.id.label("source_file_id"),
                AnalysisSourceFile.project_id,
                rn,
            )
            .filter(
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_date.isnot(None),
            )
            .subquery()
        )
        latest_source_subq = (
            db.query(ranked_subq).filter(ranked_subq.c.rn == 1).subquery()
        )

        base_query = (
            db.query(
                InventorySnapshotRow.sku,
                InventorySnapshotRow.available_qty,
                InventorySnapshotRow.stock_status,
            )
            .join(
                latest_source_subq,
                latest_source_subq.c.source_file_id == InventorySnapshotRow.source_file_id,
            )
        )
        if project_ids:
            base_query = base_query.filter(
                latest_source_subq.c.project_id.in_(project_ids)
            )

        rows = base_query.all()
        total_available = sum(int(r.available_qty or 0) for r in rows)
        oos_count = sum(
            1 for r in rows
            if (r.available_qty or 0) <= 0 or r.stock_status == "out_of_stock"
        )
        # low 与 oos 互斥：只在"非 OOS 且 0 < qty <= 20"时算 low，
        # 避免 stock_status='out_of_stock' 的 SKU 同时被算到 low 里。
        low_count = sum(
            1 for r in rows
            if 0 < (r.available_qty or 0) <= 20
            and r.stock_status != "out_of_stock"
        )

        # 在途库存：所有 shipment_status='in_transit' 的明细数量合计
        in_transit_qty = _query_in_transit_qty(db, project_ids, country)

        return {
            "sku_count": len(rows),
            "total_available": total_available,
            "low_stock_count": low_count,
            "oos_count": oos_count,
            "in_transit": in_transit_qty,
        }

    except Exception as e:
        logger.warning(f"Failed to get inventory summary: {e}")
        return {
            "sku_count": 0,
            "total_available": 0,
            "low_stock_count": 0,
            "oos_count": 0,
            "in_transit": 0,
        }


def _query_in_transit_qty(
    db: Session,
    project_ids: list[int] | None,
    country: str,
) -> int:
    """统计所有在途（shipment_status='in_transit'）的明细数量合计。"""
    try:
        normalized_country = normalize_country(country)
        row = (
            db.query(
                func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0).label("in_transit_qty"),
            )
            .join(
                ShipmentSchedule,
                ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
            )
            .filter(
                ShipmentSchedule.country == normalized_country,
                ShipmentSchedule.shipment_status == "in_transit",
            )
        )
        if project_ids:
            row = row.filter(ShipmentSchedule.project_id.in_(project_ids))
        result = row.first()
        return int(result.in_transit_qty or 0) if result else 0
    except Exception as e:
        logger.warning("Failed to query in-transit qty for %s: %s", country, e)
        return 0


def _get_ads_comparison(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date,
    curr_end: date,
    prev_start: date,
    prev_end: date,
    curr_sales_total: float = 0.0,
    prev_sales_total: float = 0.0,
) -> dict[str, Any]:
    """获取广告数据对比（本周 vs 上周）。

    查询 analysis_ad_product_rows 表，按 period_end_date 范围过滤。
    curr_sales_total / prev_sales_total 为对应周期的全站总销售额，
    用于计算广告占比（ad_ratio_all = 广告花费 / 全站总销售额）。
    """
    def _aggregate_ads(start: date, end: date) -> dict[str, float]:
        try:
            query = (
                db.query(
                    func.coalesce(func.sum(AdUploadPromotedProductRow.spend), 0).label("spend"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.sales_7d), 0).label("sales"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.clicks), 0).label("clicks"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.impressions), 0).label("impressions"),
                    func.coalesce(func.sum(AdUploadPromotedProductRow.orders_7d), 0).label("orders"),
                )
                .join(AdUploadFile, AdUploadFile.id == AdUploadPromotedProductRow.source_file_id)
                .filter(
                    AdUploadFile.country == country,
                    AdUploadFile.report_type == "ad_promoted_product_report",
                    AdUploadFile.is_current == True,
                    AdUploadFile.period_end_date >= start,
                    AdUploadFile.period_end_date <= end,
                    AdUploadPromotedProductRow.scope_status == "included_product",
                )
            )
            if project_ids:
                query = query.filter(AdUploadFile.project_id.in_(project_ids))

            row = query.first()
            spend = float(row.spend) if row and row.spend else 0.0
            sales = float(row.sales) if row and row.sales else 0.0
            clicks = int(row.clicks) if row and row.clicks else 0
            impressions = int(row.impressions) if row and row.impressions else 0

            roas = sales / spend if spend > 0 else 0.0
            acos = (spend / sales * 100) if sales > 0 else 0.0
            ctr = (clicks / impressions * 100) if impressions > 0 else 0.0

            return {"spend": spend, "sales": sales, "roas": roas, "acos": acos, "ctr": ctr}
        except Exception as e:
            logger.warning(f"Failed to aggregate ads for {start}~{end}: {e}")
            return {"spend": 0, "sales": 0, "roas": 0, "acos": 0, "ctr": 0}

    curr = _aggregate_ads(curr_start, curr_end)
    prev = _aggregate_ads(prev_start, prev_end)

    # 广告占比 = 广告花费 / 全站总销售额（非仅广告销售额）
    curr_ratio = round(curr["spend"] / curr_sales_total * 100, 2) if curr_sales_total > 0 else 0.0
    prev_ratio = round(prev["spend"] / prev_sales_total * 100, 2) if prev_sales_total > 0 else 0.0

    return {
        "spend": {"current": curr["spend"], "prev": prev["spend"], "change": _calc_change_pct(curr["spend"], prev["spend"])},
        "roas": {"current": curr["roas"], "prev": prev["roas"], "change": _calc_change_pct(curr["roas"], prev["roas"])},
        "acos": {"current": curr["acos"], "prev": prev["acos"], "change": _calc_change_pct(curr["acos"], prev["acos"])},
        "ctr": {"current": curr["ctr"], "prev": prev["ctr"], "change": _calc_change_pct(curr["ctr"], prev["ctr"])},
        "ad_ratio_all": {"current": curr_ratio, "prev": prev_ratio, "change": _calc_change_pct(curr_ratio, prev_ratio)},
    }


def _get_weekly_returns(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
    week_total_qty: int = 0,
) -> dict[str, Any]:
    """获取本周退货数据，退货率 = 退货数 / 周总销量。

    注意：退货报表是累积的，同一退货事件可能出现在多个 source_file 中。
    必须按 (order_id, sku, return_date, license_plate_number) 去重，
    只保留 source_file_id 最大的那条记录，避免重复计算。
    """
    try:
        # 查询所有匹配的退货记录
        query = (
            db.query(AnalysisReturnRow)
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisReturnRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.is_current == True,
                AnalysisReturnRow.return_date >= start_date,
                AnalysisReturnRow.return_date <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        records = query.all()

        # Python 层面去重：按 (order_id, sku, return_date, license_plate_number) 分组
        # 只保留 source_file_id 最大的那条记录
        seen: dict[tuple, tuple[int, AnalysisReturnRow]] = {}
        for r in records:
            key = (r.order_id, r.sku, r.return_date, r.license_plate_number or "")
            if key not in seen or r.source_file_id > seen[key][0]:
                seen[key] = (r.source_file_id, r)

        qty = sum(r.quantity for _, r in seen.values())
        rate = (qty / week_total_qty * 100) if week_total_qty > 0 else 0.0

        # 按退货原因聚合 TOP 3
        reason_qty: dict[str, int] = {}
        for _, r in seen.values():
            reason = r.reason or "未知"
            reason_qty[reason] = reason_qty.get(reason, 0) + r.quantity
        top_returns = sorted(
            [{"reason": k, "qty": v} for k, v in reason_qty.items()],
            key=lambda x: x["qty"], reverse=True,
        )[:3]

        return {
            "qty": qty,
            "rate": round(rate, 1),
            "top_returns": top_returns,
        }
    except Exception as e:
        logger.warning(f"Failed to get weekly returns: {e}")
        return {"qty": 0, "rate": 0.0}


def _get_daily_sales_trend(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """获取日期范围内每天的销量，用于趋势柱状图。

    返回格式: [{"date": "05-12", "qty": 10, "amount": 350.00}, ...]
    """
    try:
        query = (
            db.query(
                AnalysisSalesOrderRow.purchase_date_pt.label("day"),
                func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
                func.coalesce(func.sum(
                    sales_amount_expr(country)
                ), 0).label("amount"),
            )
            # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current）。
            .filter(
                AnalysisSalesOrderRow.country == country,
                AnalysisSalesOrderRow.is_counted_sales.is_(True),  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSalesOrderRow.project_id.in_(project_ids))

        rows = (
            query.group_by(AnalysisSalesOrderRow.purchase_date_pt)
            .order_by(AnalysisSalesOrderRow.purchase_date_pt)
            .all()
        )

        # 构建结果，补齐没有数据的日期
        result_map = {r.day: {"qty": int(r.qty), "amount": float(r.amount)} for r in rows}
        trend = []
        current = start_date
        weekday_names = ["一", "二", "三", "四", "五", "六", "日"]
        while current <= end_date:
            data = result_map.get(current, {"qty": 0, "amount": 0.0})
            wd = weekday_names[current.weekday()]
            trend.append({
                "date": f"{current.month}/{current.day}",
                "weekday": f"周{wd}",
                "qty": data["qty"],
                "amount": data["amount"],
            })
            current += timedelta(days=1)

        return trend
    except Exception as e:
        logger.warning(f"Failed to get daily sales trend: {e}")
        return []


def _build_alerts_from_anomalies(anomalies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将异常检测结果转换为预警列表。"""
    alerts = []
    for anomaly in anomalies:
        severity = anomaly.get("severity", "warning")
        alert_type = "critical" if severity == "critical" else "warning"
        
        alerts.append({
            "type": alert_type,
            "severity": severity,
            "message": anomaly.get("message", "检测到异常"),
            "action": anomaly.get("action", "请检查相关数据"),
            "category": anomaly.get("type", "general"),
        })
    return alerts


def _build_inventory_alerts(inventory_alerts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """将库存预警转换为预警列表。"""
    alerts = []
    
    oos = [a for a in inventory_alerts if a.get("level") == "oos"]
    low = [a for a in inventory_alerts if a.get("level") == "low"]
    
    if oos:
        alerts.append({
            "type": "critical",
            "severity": "critical",
            "message": f"有 {len(oos)} 个 SKU 缺货",
            "action": "立即补货",
            "category": "inventory",
            "details": oos[:3],
        })
    
    if low:
        alerts.append({
            "type": "warning",
            "severity": "warning",
            "message": f"有 {len(low)} 个 SKU 库存告急",
            "action": "尽快补货",
            "category": "inventory",
            "details": low[:3],
        })
    
    return alerts


def _build_positive_signals(
    top_skus: list[dict[str, Any]],
    ads_comparison: dict[str, Any],
) -> list[dict[str, Any]]:
    """检测积极信号。"""
    signals = []

    new_skus = [s for s in top_skus if s.get("new") and s.get("current", 0) > 50]
    if new_skus:
        signals.append({
            "type": "positive",
            "severity": "info",
            "message": f"新品 {new_skus[0]['sku']} 首周表现亮眼",
            "action": "考虑加大投放",
            "category": "growth",
        })

    roas_change = ads_comparison.get("roas", {}).get("change") or 0
    if roas_change > 10:
        signals.append({
            "type": "positive",
            "severity": "info",
            "message": f"广告 ROAS 提升 {roas_change:.1f}%",
            "action": "保持当前投放策略",
            "category": "ads",
        })

    return signals


def _query_sku_sales_detail(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> list[dict[str, Any]]:
    """查询指定日期范围的 SKU 销售明细（含品名）。

    按销量降序排列，过滤掉数量和销售额都为 0 的 SKU。
    """
    try:
        # 1) 聚合每个 SKU 的销售数据
        query = (
            db.query(
                AnalysisSalesOrderRow.sku,
                func.sum(AnalysisSalesOrderRow.quantity).label("total_qty"),
                func.sum(
                    sales_amount_expr(country)
                ).label("total_amount"),
            )
            # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current）。
            .filter(
                AnalysisSalesOrderRow.country == country,
                AnalysisSalesOrderRow.is_counted_sales.is_(True),  # noqa: E712
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSalesOrderRow.project_id.in_(project_ids))

        results = (
            query
            .group_by(AnalysisSalesOrderRow.sku)
            .order_by(func.sum(AnalysisSalesOrderRow.quantity).desc())
            .all()
        )

        # 2) 批量获取品名映射 (sku -> product_name)
        sku_names: dict[str, str] = {}
        sku_list = [r.sku for r in results if r.sku]
        if sku_list:
            name_query = (
                db.query(SkuRecord.sku, SkuRecord.product_name)
                .filter(
                    SkuRecord.sku.in_(sku_list),
                    SkuRecord.country == country,
                    SkuRecord.is_active == True,  # noqa: E712
                )
            )
            if project_ids:
                name_query = name_query.filter(SkuRecord.project_id.in_(project_ids))

            for row in name_query.all():
                if row.sku and row.product_name:
                    sku_names[row.sku] = row.product_name

        # 3) 组装结果，过滤掉数量和销售额都为 0 的行
        detail: list[dict[str, Any]] = []
        for r in results:
            qty = int(r.total_qty or 0)
            amount = float(r.total_amount or 0)
            if qty == 0 and amount == 0:
                continue
            detail.append({
                "sku": r.sku or "Unknown",
                "product_name": sku_names.get(r.sku, "—"),
                "qty": qty,
                "amount": amount,
            })

        return detail
    except Exception as e:
        logger.warning("Failed to query SKU sales detail: %s", e)
        return []

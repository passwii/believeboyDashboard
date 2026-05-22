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
    AnalysisReturnRow,
    AnalysisSalesOrderRow,
    AnalysisSourceFile,
    InventorySnapshotRow,
)
from app.services.dashboard_overview_service import build_dashboard_overview
from app.utils.country import get_today_for_country

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


def _calc_change_pct(current: float, prev: float) -> float:
    """计算变化百分比。"""
    if prev == 0:
        return 0.0
    return ((current - prev) / prev) * 100


def _format_date_range(start: date, end: date) -> str:
    """格式化日期范围为中文描述。"""
    return f"{start.month}月{start.day}日 - {end.month}月{end.day}日"


def build_weekly_report_data(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    project_name: str = "项目",
) -> dict[str, Any]:
    """构建完整的周报告数据结构。
    
    使用自然周计算：
    - 上周：上一个完整的自然周（周一到周日）
    - 上上周：再往前一周
    
    Args:
        db: 数据库会话
        project_ids: 项目 ID 列表，None 表示全部项目
        country: 国家代码
        project_name: 项目名称（用于邮件显示）
    
    Returns:
        完整的周报告数据字典
    """
    # 锚定日期
    anchor_date = _get_report_anchor_date(country)
    
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
    
    # 6. 广告数据对比
    ads_comparison = _get_ads_comparison(
        db, project_ids, country,
        prev_week_start, prev_week_end,
        prev_prev_week_start, prev_prev_week_end,
    )
    
    # 7. 退货数据
    returns_data = _get_weekly_returns(db, project_ids, country, prev_week_start, prev_week_end)
    
    # 8. 检测预警信号
    anomalies = detect_weekly_anomalies(
        current_week, prev_week, ads_comparison, returns_data
    )
    
    # 9. 构建预警列表
    alerts = _build_alerts_from_anomalies(anomalies)
    alerts.extend(_build_inventory_alerts(inventory_alerts))
    alerts.extend(_build_positive_signals(top_skus_comparison, ads_comparison))
    
    # 10. 生成 AI 摘要和归因分析
    ai_summary = generate_weekly_ai_summary({
        "current_week": current_week,
        "prev_week": prev_week,
        "changes": changes,
        "attribution": attribution,
        "alerts": alerts,
        "top_skus_comparison": top_skus_comparison,
        "ads_comparison": ads_comparison,
        "inventory_alerts": inventory_alerts,
        "returns_data": returns_data,
    })
    
    attribution_summary = generate_weekly_attribution_analysis({
        "attribution": attribution,
        "current_week": current_week,
        "prev_week": prev_week,
    })
    
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
        
        # 退货数据
        "returns_data": returns_data,
        
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
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0) +
                    func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ), 0).label("amount"),
                func.count(func.distinct(AnalysisSalesOrderRow.purchase_date_pt)).label("active_days"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
                AnalysisSalesOrderRow.purchase_date_pt >= start_date,
                AnalysisSalesOrderRow.purchase_date_pt <= end_date,
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

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
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
            )
        )
        if project_ids:
            all_skus_query = all_skus_query.filter(AnalysisSourceFile.project_id.in_(project_ids))

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
                "change_rate": round(change_rate, 1),
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
                         AnalysisSalesOrderRow.item_price + AnalysisSalesOrderRow.shipping_price),
                        else_=0,
                    )
                ).label("current_amount"),
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "sales_report",
                AnalysisSourceFile.is_current == True,
                AnalysisSalesOrderRow.purchase_date_pt.between(prev_start, curr_end),
            )
        )
        if project_ids:
            query = query.filter(AnalysisSourceFile.project_id.in_(project_ids))

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
                "change": round(change_rate, 1),
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
    """获取库存预警 SKU。"""
    try:
        base_query = (
            db.query(
                InventorySnapshotRow.sku,
                InventorySnapshotRow.available_qty,
                InventorySnapshotRow.stock_status,
            )
            .join(AnalysisSourceFile, AnalysisSourceFile.id == InventorySnapshotRow.source_file_id)
            .filter(
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.is_current == True,
            )
        )
        if project_ids:
            base_query = base_query.filter(AnalysisSourceFile.project_id.in_(project_ids))

        alerts = []
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
        return alerts

    except Exception as e:
        logger.warning(f"Failed to get inventory alerts: {e}")
        return []


def _get_ads_comparison(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    curr_start: date,
    curr_end: date,
    prev_start: date,
    prev_end: date,
) -> dict[str, Any]:
    """获取广告数据对比。"""
    # TODO: 根据实际广告数据模型实现
    return {
        "spend": {"current": 0, "prev": 0, "change": 0},
        "roas": {"current": 0, "prev": 0, "change": 0},
        "acos": {"current": 0, "prev": 0, "change": 0},
        "ctr": {"current": 0, "prev": 0, "change": 0},
    }


def _get_weekly_returns(
    db: Session,
    project_ids: list[int] | None,
    country: str,
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """获取本周退货数据。"""
    try:
        query = (
            db.query(
                func.coalesce(func.sum(AnalysisReturnRow.quantity), 0).label("qty"),
            )
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

        row = query.first()
        qty = int(row.qty) if row and row.qty else 0
        
        return {
            "qty": qty,
            "rate": 0.0,
        }
    except Exception as e:
        logger.warning(f"Failed to get weekly returns: {e}")
        return {"qty": 0, "rate": 0.0}


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
    
    roas_change = ads_comparison.get("roas", {}).get("change", 0)
    if roas_change > 10:
        signals.append({
            "type": "positive",
            "severity": "info",
            "message": f"广告 ROAS 提升 {roas_change:.1f}%",
            "action": "保持当前投放策略",
            "category": "ads",
        })
    
    return signals

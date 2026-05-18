"""Return analysis and reporting logic.

Extracted from return_analysis_service.py (phase 5 of backend refactor plan).
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models import (
    AnalysisReturnRow,
    AnalysisSourceFile,
    SkuRecord,
    Project,
    ReturnAnalysisRecord,
    ReturnCustomerComment,
)


def _safe_rate(numerator: int, denominator: int) -> float:
    """Safely calculate return rate as a percentage."""
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator * 100, 2)


def _build_sku_product_name_map(db: Session, project_id: int, country: str, skus: list[str]) -> dict[str, str]:
    """Look up product names from SkuRecord table by SKU.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code
        skus: List of SKU strings to look up

    Returns:
        dict[sku] -> product_name (empty string if not found)
    """
    if not skus:
        return {}

    sku_records = (
        db.query(SkuRecord.sku, SkuRecord.product_name)
        .filter(
            SkuRecord.project_id == project_id,
            SkuRecord.country == country,
            SkuRecord.sku.in_(skus),
            SkuRecord.is_active == True,
        )
        .all()
    )
    return {sku: product_name for sku, product_name in sku_records if product_name}


def _build_sales_aggregates(
    db: Session,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
):
    """Query period sales data aggregated by SKU and date.

    Returns:
        sku_sales: dict[sku] -> {"quantity": int, "amount": float}
        date_sales: dict[date_str] -> {"quantity": int, "amount": float}
    """
    from app.models import AnalysisSalesOrderRow, AnalysisSourceFile

    q = (
        db.query(
            AnalysisSalesOrderRow.sku,
            AnalysisSalesOrderRow.purchase_date_pt,
            AnalysisSalesOrderRow.quantity,
            AnalysisSalesOrderRow.item_price,
        )
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.purchase_date_pt >= date.fromisoformat(start_date),
            AnalysisSalesOrderRow.purchase_date_pt <= date.fromisoformat(end_date),
            AnalysisSalesOrderRow.is_counted_sales == True,
        )
    )

    sku_sales: dict[str, dict] = {}
    date_sales: dict[str, dict] = {}

    for row in q.all():
        sku = row.sku or ""
        date_str = row.purchase_date_pt.isoformat()
        amount = float(row.item_price) if row.item_price else 0.0

        if sku not in sku_sales:
            sku_sales[sku] = {"quantity": 0, "amount": 0.0}
        sku_sales[sku]["quantity"] += row.quantity
        sku_sales[sku]["amount"] += amount

        if date_str not in date_sales:
            date_sales[date_str] = {"quantity": 0, "amount": 0.0}
        date_sales[date_str]["quantity"] += row.quantity
        date_sales[date_str]["amount"] += amount

    return sku_sales, date_sales


def _build_summary_text(
    total_returns: int,
    total_quantity: int,
    unique_skus: int,
    ranking_rows: list,
    reason_rows: list,
    trend_rows: list,
    disposition_rows: list,
    status_rows: list,
    start_date: str,
    end_date: str,
    project_name: str,
    weekday_rows: list,
    fulfillment_center_rows: list,
    multi_item_return_count: int,
    multi_item_return_quantity: int,
    feedback_rows: list,
    total_sales_quantity: int = 0,
    total_sales_amount: float = 0.0,
    overall_return_rate: float = 0.0,
) -> str:
    """Generate a human-readable summary text from return analysis data."""

    WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

    def top_n(items: list, field: str = "return_count", n: int = 3) -> str:
        result = []
        for item in items[:n]:
            val = getattr(item, field, 0)
            name = (
                getattr(item, "reason_display", None)
                or getattr(item, "detailed_disposition", None)
                or getattr(item, "status_display", None)
                or getattr(item, "sku", "")
                or getattr(item, "fulfillment_center_id", "")
            )
            pct = getattr(item, "percentage", None)
            label = name
            if pct is not None:
                result.append(f"{label}（{pct}%，{val}单）")
            else:
                result.append(f"{label}（{val}单）")
        return "；".join(result)

    def calc_trend(trend_rows: list) -> tuple[str, str]:
        if len(trend_rows) < 2:
            return "数据不足，无法判断趋势", ""
        vals = [r.return_count for r in trend_rows]
        first_half = sum(vals[: len(vals) // 2])
        second_half = sum(vals[len(vals) // 2 :])
        days_first = len(vals) // 2 or 1
        days_second = len(vals) - len(vals) // 2 or 1
        avg_first = first_half / days_first
        avg_second = second_half / days_second
        if avg_second > avg_first * 1.15:
            direction = "上升📈"
            change_pct = round((avg_second - avg_first) / avg_first * 100)
        elif avg_second < avg_first * 0.85:
            direction = "下降📉"
            change_pct = round((avg_first - avg_second) / avg_first * 100)
        else:
            direction = "基本持平➡️"
            change_pct = 0
        if change_pct > 0:
            change_str = f"后半段较前半段{direction}约{change_pct}%"
        else:
            change_str = f"整体{direction}，变化幅度约{abs(change_pct)}%"
        return direction, change_str

    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        date_range_days = (end_dt - start_dt).days + 1
    except Exception:
        date_range_days = max(1, len(trend_rows))

    daily_avg = round(total_returns / date_range_days, 1) if date_range_days > 0 else 0

    multi_item_rate = (
        round(multi_item_return_count / total_returns * 100, 1) if total_returns > 0 else 0
    )

    daily_avg_sales = round(total_sales_quantity / date_range_days, 1) if date_range_days > 0 else 0

    parts: list[str] = []

    if total_sales_quantity > 0:
        parts.append(f"📦 销售概况（{start_date} 至 {end_date}，共 {date_range_days} 天）")
        parts.append(
            f"同周期内共售出 {total_sales_quantity} 件，累计销售额约 ${total_sales_amount:,.2f}，"
            f"日均销售约 {daily_avg_sales} 件。"
        )
        parts.append("")

    parts.append(f"📊 退货概况（{start_date} 至 {end_date}，共 {date_range_days} 天）")
    parts.append(
        f"本周期内共产生 {total_returns} 笔退货，涉及 {total_quantity} 件商品，覆盖 {unique_skus} 个 SKU。"
        f"日均退货约 {daily_avg} 单。"
    )
    if total_sales_quantity > 0:
        parts.append(
            f"整体退货率约 {overall_return_rate}%（退货量 {total_quantity} / 销售量 {total_sales_quantity}），"
            f"参考基准：服装类 3%~8%，一般零售 < 5%。"
        )
    elif total_returns > 0:
        parts.append(
            f"ℹ️ 暂无同期销售数据，无法计算退货率。"
            f"服装类行业平均退货率约 3%~8%，一般零售品平均 < 5%。"
        )
    else:
        parts.append(
            f"ℹ️ 参考基准：服装类行业平均退货率约 3%~8%，一般零售品平均 < 5%。"
        )

    if ranking_rows:
        top_sku = ranking_rows[0]
        sku_sales_qty = getattr(top_sku, "sales_quantity", 0)
        sku_return_rate = getattr(top_sku, "return_rate", 0.0)
        rate_str = f"，退货率 {sku_return_rate}%" if sku_sales_qty > 0 else ""
        parts.append("")
        parts.append(f"⚠️ 高退货 SKU（按退货量）")
        parts.append(f"Top1：{top_sku.sku}（{top_sku.total_quantity}件，退货{top_sku.return_count}单{rate_str}）")

        def _get_sku_sales_qty(row):
            return getattr(row, "sales_quantity", 0) or 0

        def _get_sku_return_rate(row):
            return getattr(row, "return_rate", 0.0) or 0.0

        if top_sku.total_quantity > total_quantity * 0.25:
            parts.append(
                f"⚡ 该 SKU 退货量占总量的 {round(top_sku.total_quantity/total_quantity*100,1)}%，"
                f"属于极高风险单品，建议立即优先排查。"
            )
        elif top_sku.total_quantity > total_quantity * 0.15:
            parts.append(f"⚡ 该 SKU 退货量占总量的 {round(top_sku.total_quantity/total_quantity*100,1)}%，属于高风险单品。")
        if len(ranking_rows) > 1:
            rest = []
            for row in ranking_rows[1:3]:
                sq = _get_sku_sales_qty(row)
                rr = _get_sku_return_rate(row)
                rs = f"（{row.total_quantity}件，退货率{rr}%）" if sq > 0 else f"（{row.total_quantity}件）"
                rest.append(f"{row.sku}{rs}")
            parts.append(f"Top2-3：{'；'.join(rest)}")
        parts.append(f"其余 {max(0, len(ranking_rows)-3)} 个 SKU 退货量相对较低。")

        top3_qty = sum(r.total_quantity for r in ranking_rows[:3])
        if top3_qty > total_quantity * 0.5:
            parts.append(
                f"⚠️ 集中度风险：Top3 SKU 退货量占总量的 {round(top3_qty/total_quantity*100,1)}%，"
                f"退货问题高度集中在这几款产品上。"
            )

    if reason_rows:
        top_reason = reason_rows[0]
        parts.append("")
        parts.append(f"🔍 退货原因分析")
        parts.append(
            f"最主要原因：{top_reason.reason_display}，占全部退货的 {top_reason.percentage}%。"
        )
        if len(reason_rows) > 1:
            parts.append(f"其他主要原因：{top_n(reason_rows[1:], 'return_count', 3)}。")

        quality_items = [
            r
            for r in reason_rows
            if r.reason in ("QUALITY_UNACCEPTABLE", "DEFECTIVE")
        ]
        if quality_items:
            total_quality_pct = sum(r.percentage for r in quality_items)
            if total_quality_pct > 10:
                parts.append(
                    f"⚡ 质量相关退货占比 {round(total_quality_pct, 1)}%，需重点关注产品质量。"
                )

        size_items = [
            r for r in reason_rows if r.reason in ("APPAREL_TOO_LARGE", "APPAREL_TOO_SMALL")
        ]
        if size_items:
            total_size_pct = sum(r.percentage for r in size_items)
            if total_size_pct > 5:
                parts.append(
                    f"📏 尺码相关退货占比 {round(total_size_pct, 1)}%，"
                    f"建议检查尺码表准确性，考虑在产品页增加测量说明。"
                )

        mismatch_items = [r for r in reason_rows if r.reason == "NOT_AS_DESCRIBED"]
        if mismatch_items and mismatch_items[0].percentage > 5:
            parts.append(
                f"🖼️ 「与描述不符」退货占比 {mismatch_items[0].percentage}%，"
                f"建议核查产品图片、标题及详情页描述是否与实物一致。"
            )

    if multi_item_return_count > 0:
        multi_qty_pct = round(multi_item_return_quantity / total_quantity * 100, 1)
        parts.append("")
        parts.append(f"📦 多件退货分析")
        parts.append(
            f"本期内有 {multi_item_return_count} 笔退货涉及多件商品，"
            f"合计 {multi_item_return_quantity} 件，占总退货量的 {multi_qty_pct}%。"
        )
        if multi_item_rate > 20:
            parts.append(
                f"⚡ 多件退货比例较高，可能存在批量质量或包装问题，建议抽检该批次产品。"
            )
        elif multi_item_rate > 10:
            parts.append(
                f"多件退货比例偏高，值得关注是否为同批次产品存在系统性问题。"
            )

    if trend_rows:
        direction, change_str = calc_trend(trend_rows)
        peak_day = max(trend_rows, key=lambda r: r.return_count)
        low_day = min(trend_rows, key=lambda r: r.return_count)
        parts.append("")
        parts.append(f"📈 退货趋势（按日）")
        parts.append(f"整体趋势：{change_str}。")
        parts.append(
            f"退货高峰日：{peak_day.date}（{peak_day.return_count}单）；"
            f"最低日：{low_day.date}（{low_day.return_count}单）。"
        )
        if len(trend_rows) >= 7:
            last_3 = sum(r.return_count for r in trend_rows[-3:])
            prev_3 = sum(r.return_count for r in trend_rows[-6:-3]) if len(trend_rows) >= 6 else 0
            if prev_3 > 0:
                recent_trend_pct = round((last_3 - prev_3) / prev_3 * 100, 1)
                if abs(recent_trend_pct) >= 10:
                    trend_label = "回升📈" if recent_trend_pct > 0 else "回落📉"
                    parts.append(
                        f"近3天退货量较前3天{trend_label} {abs(recent_trend_pct)}%，"
                        f"建议持续关注是否有突发事件。"
                    )

    if weekday_rows:
        peak_weekday = max(weekday_rows, key=lambda r: r.return_count)
        weekday_str = "、".join(
            WEEKDAY_NAMES[w.weekday] for w in weekday_rows if w.return_count > 0
        )
        parts.append("")
        parts.append(f"🗓️ 星期分布")
        parts.append(f"退货分布：{weekday_str}。")
        if peak_weekday.return_count > daily_avg * 1.5 and daily_avg > 0:
            parts.append(
                f"⚡ {WEEKDAY_NAMES[peak_weekday.weekday]}退货最多（{peak_weekday.return_count}单），"
                f"高于日均值，建议分析该日订单处理流程是否有特殊因素。"
            )

    if fulfillment_center_rows:
        top_fc = fulfillment_center_rows[0]
        fc_total_returns = sum(fc.return_count for fc in fulfillment_center_rows)
        fc_top_pct = round(top_fc.return_count / fc_total_returns * 100, 1) if fc_total_returns > 0 else 0
        parts.append("")
        parts.append(f"🏭 仓库分布")
        parts.append(
            f"退货涉及 {len(fulfillment_center_rows)} 个仓库，"
            f"其中 {top_fc.fulfillment_center_id} 退货最多（{top_fc.return_count}单，占比{fc_top_pct}%）。"
        )
        if fc_top_pct > 50:
            parts.append(
                f"⚡ 该仓库退货集中度偏高，可能存在该仓库特有的存储、发货或操作问题，"
                f"建议与仓库管理方沟通核查。"
            )
        elif len(fulfillment_center_rows) > 1:
            parts.append(f"其余仓库分布：{top_n(fulfillment_center_rows[1:], 'return_count', 2)}。")

    if disposition_rows:
        resellable = next(
            (d for d in disposition_rows if "可售" in d.disposition_display),
            None,
        )
        damaged = next(
            (
                d
                for d in disposition_rows
                if "损坏" in d.disposition_display or "废弃" in d.disposition_display
            ),
            None,
        )
        parts.append("")
        parts.append(f"📦 商品处理状态")
        if resellable:
            parts.append(
                f"可售商品：{resellable.disposition_display}（{resellable.percentage}%），可直接回库再售。"
            )
        if damaged:
            parts.append(
                f"损坏/废弃：{damaged.disposition_display}（{damaged.percentage}%），需计入损耗成本。"
            )
        if not resellable and not damaged:
            parts.append(f"主要处置方式：{top_n(disposition_rows, 'return_count', 2)}。")

    if status_rows:
        pending = next(
            (
                s
                for s in status_rows
                if "待处理" in s.status_display or "pending" in s.status.lower()
            ),
            None,
        )
        completed = next(
            (
                s
                for s in status_rows
                if "完成" in s.status_display or "completed" in s.status.lower()
            ),
            None,
        )
        parts.append("")
        parts.append(f"🏭 库存处理进度")
        if completed:
            parts.append(f"已完成处理：{completed.status_display}（{completed.percentage}%）。")
        if pending:
            parts.append(
                f"待处理：{pending.status_display}（{pending.percentage}%），"
                f"建议优先处理以释放库存压力。"
            )
            if pending.percentage > 30:
                parts.append(
                    f"⚡ 待处理比例超过 30%，库存积压风险较高，请加快处理节奏。"
                )

    if feedback_rows:
        from collections import Counter
        reason_counter = Counter(r.reason_display for r in feedback_rows)
        top_feedback_reasons = reason_counter.most_common(3)
        total_feedback = len(feedback_rows)
        parts.append("")
        parts.append(f"💬 顾客反馈摘要（共 {total_feedback} 条有评论）")
        for reason, count in top_feedback_reasons:
            pct = round(count / total_feedback * 100, 1)
            parts.append(f"·「{reason}」：{count}条（{pct}%）")
        if feedback_rows and feedback_rows[0].customer_comment:
            sample = feedback_rows[0].customer_comment[:80]
            parts.append(f"典型反馈：「{sample}{'...' if len(feedback_rows[0].customer_comment) > 80 else ''}」")

    parts.append("")
    parts.append("💡 综合建议")
    suggestions: list[str] = []

    if reason_rows and reason_rows[0].percentage > 30:
        suggestions.append(
            f"「{reason_rows[0].reason_display}」问题突出（占比{reason_rows[0].percentage}%），"
            f"建议从产品描述、尺码选择指引或质量控制环节入手改进。"
        )
    elif reason_rows and reason_rows[0].percentage > 20:
        suggestions.append(
            f"「{reason_rows[0].reason_display}」是首要退货原因（{reason_rows[0].percentage}%），"
            f"建议针对性制定改善计划。"
        )

    if ranking_rows and ranking_rows[0].total_quantity > total_quantity * 0.3:
        suggestions.append(
            f"SKU「{ranking_rows[0].sku}」退货量过高（占总量{round(ranking_rows[0].total_quantity/total_quantity*100,1)}%），"
            f"建议单独深度分析该商品并考虑优化listing或临时下架。"
        )

    if trend_rows:
        direction, _ = calc_trend(trend_rows)
        if "上升" in direction:
            suggestions.append(
                "退货量呈上升趋势，建议密切关注近期待发货商品质量，必要时加强质检环节。"
            )

    if status_rows and pending and pending.percentage > 30:
        suggestions.append(
            "待处理退货较多，库存积压风险上升，建议加快处理节奏，避免产生额外仓储成本。"
        )

    if multi_item_rate > 15:
        suggestions.append(
            f"多件退货比例偏高（{multi_item_rate}%），建议抽检相关批次，排除批量性质量缺陷。"
        )

    if weekday_rows:
        peak_w = max(weekday_rows, key=lambda r: r.return_count)
        if peak_w.weekday in (5, 6) and peak_w.return_count > daily_avg * 1.3 and daily_avg > 0:
            suggestions.append(
                "周末退货量相对更高，可能与周末签收后用户有更多时间检查商品有关，"
                "建议关注周末发货的包装防护质量。"
            )

    if not suggestions:
        suggestions.append("整体退货情况在正常范围内，继续保持现有运营状态。")
    parts.extend(suggestions)

    parts.append("")
    parts.append(
        f"📋 数据说明：本报告基于 {start_date} 至 {end_date} 共 {date_range_days} 天的退货记录汇总生成。"
        f"日均退货 {daily_avg} 单，覆盖 {unique_skus} 个 SKU。数据仅供参考，实际决策请结合业务情况判断。"
    )

    return "\n".join(parts)


def build_return_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
):
    """Build comprehensive return analysis data.

    Args:
        db: Database session
        project_id: Project ID
        country: Country code (currently only US)
        start_date: Start date (YYYY-MM-DD)
        end_date: End date (YYYY-MM-DD)
        sku: Optional SKU filter

    Returns:
        ReturnAnalysisResponse
    """
    from app.constants.return_translations import (
        translate_return_field,
    )
    from app.schemas.return_analysis import (
        CustomerFeedbackItem,
        DispositionItem,
        FulfillmentCenterItem,
        ReturnAnalysisResponse,
        ReturnAnalysisSummary,
        ReturnRankingItem,
        ReturnReasonItem,
        ReturnTrendItem,
        StatusItem,
        WeekdayItem,
    )

    # Try AnalysisReturnRow (new source linked to AnalysisSourceFile) first
    new_records_query = (
        db.query(AnalysisReturnRow)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,
            AnalysisReturnRow.return_date >= date.fromisoformat(start_date),
            AnalysisReturnRow.return_date <= date.fromisoformat(end_date),
        )
    )
    if sku:
        new_records_query = new_records_query.filter(AnalysisReturnRow.sku == sku)

    raw_records: list = new_records_query.all()
    is_new_source = bool(raw_records)

    # Amazon return reports are cumulative: each daily snapshot contains ALL
    # active returns, not just new ones for that day.  When multiple daily
    # source files are stored (all is_current=True), the same return event
    # (order_id, sku, return_date, license_plate_number) appears in every
    # file that covers it.  We must keep only the row from the **latest**
    # source file to avoid inflating quantities.
    if raw_records:
        seen: dict[tuple, AnalysisReturnRow] = {}
        for r in raw_records:
            key = (r.order_id, r.sku, str(r.return_date), r.license_plate_number or "")
            if key not in seen or r.source_file_id > seen[key].source_file_id:
                seen[key] = r
        records = list(seen.values())
    else:
        records = []

    if not records:
        # Fall back to legacy ReturnAnalysisRecord
        query = db.query(ReturnAnalysisRecord).filter(
            ReturnAnalysisRecord.project_id == project_id,
            ReturnAnalysisRecord.country == country,
            ReturnAnalysisRecord.is_current == True,
            ReturnAnalysisRecord.return_date >= start_date,
            ReturnAnalysisRecord.return_date <= end_date,
        )
        if sku:
            query = query.filter(ReturnAnalysisRecord.sku == sku)
        records = list(query.all())

    # Normalize return_date to string regardless of source
    if records and isinstance(records[0].return_date, date):
        for r in records:
            r.return_date = r.return_date.isoformat()

    sku_sales, date_sales = _build_sales_aggregates(
        db, project_id, country, start_date, end_date
    )

    # ── Build unique return event tracker ──────────────────────────────────────
    # Key insight: "return_count" should be # of unique return orders (order_id + sku),
    # NOT the raw row count. A single order can have multiple rows (partial returns)
    # but counts as ONE return event.
    #
    # We also track per-SKU and per-reason unique counts while iterating once.

    # Set of unique return event keys: (order_id, sku)
    unique_return_keys: set[tuple[str, str]] = set()
    # Per-SKU unique return order count: sku -> count
    sku_unique_count: dict[str, int] = {}
    # Per-reason unique return order count: reason -> count
    reason_unique_count: dict[str, int] = {}

    for r in records:
        key = (r.order_id, r.sku)
        if key not in unique_return_keys:
            unique_return_keys.add(key)
            # New unique return event — count it for SKU and reason
            sku_unique_count[r.sku] = sku_unique_count.get(r.sku, 0) + 1
            reason_unique_count[r.reason] = reason_unique_count.get(r.reason, 0) + 1

    total_returns = len(unique_return_keys)
    total_quantity = sum(r.quantity for r in records)
    unique_skus = len(set(r.sku for r in records))

    # Build set of unique SKUs for product name lookup
    unique_sku_list = list(set(r.sku for r in records))
    sku_product_name_map = _build_sku_product_name_map(db, project_id, country, unique_sku_list)

    sku_data: dict[str, dict] = {}
    for r in records:
        if r.sku not in sku_data:
            # Prefer SkuRecord product_name, fall back to report's product_name
            sku_product_name = sku_product_name_map.get(r.sku) or r.product_name
            sku_data[r.sku] = {
                "sku": r.sku,
                "asin": r.asin,
                "product_name": sku_product_name,
                "total_quantity": 0,
                "return_count": 0,
            }
        sku_data[r.sku]["total_quantity"] += r.quantity
        # Use pre-computed unique return order count, not raw row count
        sku_data[r.sku]["return_count"] = sku_unique_count.get(r.sku, 0)

    total_sales_quantity = sum(v["quantity"] for v in sku_sales.values())
    total_sales_amount = sum(v["amount"] for v in sku_sales.values())
    overall_return_rate = _safe_rate(total_quantity, total_sales_quantity)

    ranking_rows: list[ReturnRankingItem] = []
    for v in sku_data.values():
        s = sku_sales.get(v["sku"], {"quantity": 0, "amount": 0.0})
        ranking_rows.append(
            ReturnRankingItem(
                sku=v["sku"],
                asin=v["asin"],
                product_name=v["product_name"],
                total_quantity=v["total_quantity"],
                return_count=v["return_count"],
                sales_quantity=s["quantity"],
                return_rate=_safe_rate(v["total_quantity"], s["quantity"]),
            )
        )
    ranking_rows.sort(key=lambda x: x.total_quantity, reverse=True)
    ranking_rows = ranking_rows[:20]

    reason_data: dict[str, dict] = {}
    for r in records:
        if r.reason not in reason_data:
            reason_data[r.reason] = {
                "reason": r.reason,
                "total_quantity": 0,
                "return_count": 0,
            }
        reason_data[r.reason]["total_quantity"] += r.quantity
        reason_data[r.reason]["return_count"] = reason_unique_count.get(r.reason, 0)

    reason_rows = sorted(
        [
            ReturnReasonItem(
                reason=k,
                reason_display=translate_return_field("reason", k),
                total_quantity=v["total_quantity"],
                return_count=v["return_count"],
                percentage=round(v["return_count"] / total_returns * 100, 2)
                if total_returns > 0
                else 0,
            )
            for k, v in reason_data.items()
        ],
        key=lambda x: x.return_count,
        reverse=True,
    )

    # ── date-level unique return counts ──────────────────────────────────────
    # Track unique (order_id, sku) per date for accurate trend return_count
    date_unique_keys: dict[str, set[tuple[str, str]]] = {}
    for r in records:
        if r.return_date not in date_unique_keys:
            date_unique_keys[r.return_date] = set()
        date_unique_keys[r.return_date].add((r.order_id, r.sku))

    date_data: dict[str, dict] = {}
    for r in records:
        if r.return_date not in date_data:
            date_data[r.return_date] = {
                "date": r.return_date,
                "total_quantity": 0,
                "return_count": 0,
            }
        date_data[r.return_date]["total_quantity"] += r.quantity
    # Set return_count to unique order+sku count for this date
    for d, keys in date_unique_keys.items():
        if d in date_data:
            date_data[d]["return_count"] = len(keys)

    trend_rows: list[ReturnTrendItem] = []
    for v in date_data.values():
        s = date_sales.get(v["date"], {"quantity": 0, "amount": 0.0})
        trend_rows.append(
            ReturnTrendItem(
                date=v["date"],
                total_quantity=v["total_quantity"],
                return_count=v["return_count"],
                sales_quantity=s["quantity"],
                sales_amount=round(s["amount"], 2),
                return_rate=_safe_rate(v["total_quantity"], s["quantity"]),
            )
        )
    trend_rows.sort(key=lambda x: x.date)

    # ── disposition-level unique return counts ────────────────────────────────
    disposition_unique_keys: dict[str, set[tuple[str, str]]] = {}
    for r in records:
        if r.detailed_disposition not in disposition_unique_keys:
            disposition_unique_keys[r.detailed_disposition] = set()
        disposition_unique_keys[r.detailed_disposition].add((r.order_id, r.sku))

    disposition_data: dict[str, dict] = {}
    for r in records:
        if r.detailed_disposition not in disposition_data:
            disposition_data[r.detailed_disposition] = {
                "detailed_disposition": r.detailed_disposition,
                "total_quantity": 0,
                "return_count": 0,
            }
        disposition_data[r.detailed_disposition]["total_quantity"] += r.quantity
    for d, keys in disposition_unique_keys.items():
        if d in disposition_data:
            disposition_data[d]["return_count"] = len(keys)

    disposition_rows = sorted(
        [
            DispositionItem(
                detailed_disposition=k,
                disposition_display=translate_return_field("disposition", k),
                total_quantity=v["total_quantity"],
                return_count=v["return_count"],
                percentage=round(v["return_count"] / total_returns * 100, 2)
                if total_returns > 0
                else 0,
            )
            for k, v in disposition_data.items()
        ],
        key=lambda x: x.return_count,
        reverse=True,
    )

    # ── status-level unique return counts ────────────────────────────────────
    status_unique_keys: dict[str, set[tuple[str, str]]] = {}
    for r in records:
        if r.status not in status_unique_keys:
            status_unique_keys[r.status] = set()
        status_unique_keys[r.status].add((r.order_id, r.sku))

    status_data: dict[str, dict] = {}
    for r in records:
        if r.status not in status_data:
            status_data[r.status] = {
                "status": r.status,
                "total_quantity": 0,
                "return_count": 0,
            }
        status_data[r.status]["total_quantity"] += r.quantity
    for s, keys in status_unique_keys.items():
        if s in status_data:
            status_data[s]["return_count"] = len(keys)

    status_rows = sorted(
        [
            StatusItem(
                status=k,
                status_display=translate_return_field("status", k),
                total_quantity=v["total_quantity"],
                return_count=v["return_count"],
                percentage=round(v["return_count"] / total_returns * 100, 2)
                if total_returns > 0
                else 0,
            )
            for k, v in status_data.items()
        ],
        key=lambda x: x.return_count,
        reverse=True,
    )

    feedback_rows: list[CustomerFeedbackItem] = []
    if is_new_source:
        # AnalysisReturnRow stores comments inline (pipe-delimited)
        for r in records:
            if not r.customer_comments:
                continue
            parts = [c.strip() for c in r.customer_comments.split("|") if c.strip()]
            for comment in parts:
                feedback_rows.append(
                    CustomerFeedbackItem(
                        sku=r.sku,
                        order_id=r.order_id,
                        reason=r.reason,
                        reason_display=translate_return_field("reason", r.reason),
                        customer_comment=comment,
                        return_date=r.return_date,
                    )
                )
    else:
        # Legacy: ReturnCustomerComment table
        record_ids = [r.id for r in records]
        if record_ids:
            comments = (
                db.query(ReturnCustomerComment)
                .filter(ReturnCustomerComment.return_record_id.in_(record_ids))
                .all()
            )
            record_map = {r.id: r for r in records}

            for c in comments:
                if c.return_record_id in record_map:
                    r = record_map[c.return_record_id]
                    feedback_rows.append(
                        CustomerFeedbackItem(
                            sku=r.sku,
                            order_id=r.order_id,
                            reason=r.reason,
                            reason_display=translate_return_field("reason", r.reason),
                            customer_comment=c.customer_comment,
                            return_date=r.return_date,
                        )
                    )

    # ── weekday-level unique return counts ───────────────────────────────────
    from collections import Counter

    weekday_counter: dict[int, Counter] = Counter()
    for r in records:
        try:
            dt = datetime.strptime(r.return_date, "%Y-%m-%d")
            weekday_counter[dt.weekday()].add((r.order_id, r.sku))
        except Exception:
            pass

    weekday_display_map = {0: "周一", 1: "周二", 2: "周三", 3: "周四", 4: "周五", 5: "周六", 6: "周日"}
    weekday_rows = sorted(
        [
            WeekdayItem(
                weekday=w,
                weekday_display=weekday_display_map.get(w, str(w)),
                return_count=len(c),
                percentage=round(len(c) / total_returns * 100, 2) if total_returns > 0 else 0,
            )
            for w, c in weekday_counter.items()
        ],
        key=lambda x: x.weekday,
    )

    # ── fulfillment center unique return counts ──────────────────────────────
    fc_unique_keys: dict[str, set[tuple[str, str]]] = {}
    for r in records:
        fc = r.fulfillment_center_id or "未知仓库"
        if fc not in fc_unique_keys:
            fc_unique_keys[fc] = set()
        fc_unique_keys[fc].add((r.order_id, r.sku))

    fc_counter: dict[str, dict] = {}
    for r in records:
        fc = r.fulfillment_center_id or "未知仓库"
        if fc not in fc_counter:
            fc_counter[fc] = {"return_count": 0, "quantity": 0}
        fc_counter[fc]["quantity"] += r.quantity
    # Set return_count to unique order+sku count for this FC
    for fc, keys in fc_unique_keys.items():
        if fc in fc_counter:
            fc_counter[fc]["return_count"] = len(keys)

    total_fc_returns = sum(v["return_count"] for v in fc_counter.values())
    fulfillment_center_rows = sorted(
        [
            FulfillmentCenterItem(
                fulfillment_center_id=k,
                return_count=v["return_count"],
                quantity=v["quantity"],
                percentage=round(v["return_count"] / total_fc_returns * 100, 2)
                if total_fc_returns > 0
                else 0,
            )
            for k, v in fc_counter.items()
        ],
        key=lambda x: x.return_count,
        reverse=True,
    )

    multi_item_return_count = sum(1 for r in records if r.quantity > 1)
    multi_item_return_quantity = sum(r.quantity for r in records if r.quantity > 1)

    project = db.query(Project).filter(Project.id == project_id).first()
    project_name = project.project_name if project else ""

    summary_text = _build_summary_text(
        total_returns=total_returns,
        total_quantity=total_quantity,
        unique_skus=unique_skus,
        ranking_rows=ranking_rows,
        reason_rows=reason_rows,
        trend_rows=trend_rows,
        disposition_rows=disposition_rows,
        status_rows=status_rows,
        start_date=start_date,
        end_date=end_date,
        project_name=project_name,
        weekday_rows=weekday_rows,
        fulfillment_center_rows=fulfillment_center_rows,
        multi_item_return_count=multi_item_return_count,
        multi_item_return_quantity=multi_item_return_quantity,
        feedback_rows=feedback_rows,
        total_sales_quantity=total_sales_quantity,
        total_sales_amount=round(total_sales_amount, 2),
        overall_return_rate=overall_return_rate,
    )

    summary = ReturnAnalysisSummary(
        total_returns=total_returns,
        total_quantity=total_quantity,
        unique_skus=unique_skus,
        top_return_sku=ranking_rows[0].sku if ranking_rows else None,
        top_return_reason=reason_rows[0].reason if reason_rows else None,
        total_sales_quantity=total_sales_quantity,
        total_sales_amount=round(total_sales_amount, 2),
        overall_return_rate=overall_return_rate,
    )

    return ReturnAnalysisResponse(
        project_id=project_id,
        project_name=project_name,
        country=country,
        start_date=start_date,
        end_date=end_date,
        summary=summary,
        summary_text=summary_text,
        ranking_rows=ranking_rows,
        reason_rows=reason_rows,
        trend_rows=trend_rows,
        disposition_rows=disposition_rows,
        status_rows=status_rows,
        feedback_rows=feedback_rows,
        weekday_rows=weekday_rows,
        fulfillment_center_rows=fulfillment_center_rows,
        multi_item_return_count=multi_item_return_count,
        multi_item_return_quantity=multi_item_return_quantity,
    )


__all__ = [
    "_safe_rate",
    "_build_sales_aggregates",
    "_build_summary_text",
    "build_return_analysis",
]

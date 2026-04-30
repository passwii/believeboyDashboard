"""退货分析服务 - 处理退货报告的解析和入库"""

from datetime import date, datetime
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import delete
from sqlalchemy.orm import Session
from zoneinfo import ZoneInfo

from app.models import Project, ReturnAnalysisRecord, ReturnCustomerComment


# 美国时区
US_TIMEZONE = ZoneInfo("America/Los_Angeles")


def _read_csv_with_encoding_fallback(path: str | Path, sep: str = "\t") -> pd.DataFrame:
    """Try UTF-8 first, fall back to CP1252 (Windows-1252) if decode fails."""
    for encoding in ("utf-8-sig", "utf-8", "cp1252"):
        try:
            return pd.read_csv(path, sep=sep, encoding=encoding)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, sep=sep, encoding="latin-1")


def _parse_iso_datetime_with_timezone(date_str: str) -> datetime | None:
    """解析ISO格式的时间字符串（带时区），如 2026-03-31T23:05:02+00:00"""
    try:
        if not date_str or pd.isna(date_str):
            return None
        parsed = pd.to_datetime(date_str, errors="coerce", utc=True)
        if parsed is None or pd.isna(parsed):
            return None
        return parsed.to_pydatetime()
    except Exception:
        return None


def _convert_to_us_date(iso_datetime: datetime) -> str:
    """将UTC时间转换为美国日期（美国时间）"""
    if iso_datetime.tzinfo is None:
        iso_datetime = iso_datetime.replace(tzinfo=None)
    us_dt = iso_datetime.astimezone(US_TIMEZONE)
    return us_dt.strftime("%Y-%m-%d")


def _split_customer_comments(comment: str) -> list[str]:
    """将pipe分隔的评论拆分为列表"""
    if not comment or pd.isna(comment):
        return []
    # 清理HTML实体
    cleaned = str(comment).replace("&#39;", "'").replace("&amp;", "&")
    # 按pipe分隔
    parts = cleaned.split("|")
    return [p.strip() for p in parts if p.strip()]


def persist_return_report(
    db: Session,
    *,
    project_name: str,
    country: str,
    file_path: str,
    created_by: str | None = None,
) -> dict[str, Any]:
    """
    解析并入库退货报告

    Returns:
        dict with keys: success (bool), source_id (int), report_start_date, report_end_date, message
    """
    try:
        # 获取项目ID
        project = db.execute(
            Project.__table__.select().where(Project.project_name == project_name)
        ).fetchone()
        if not project:
            return {"success": False, "error_message": f"项目 {project_name} 不存在"}
        project_id = project.id

        # 读取退货报告
        df = _read_csv_with_encoding_fallback(file_path)
        df.columns = [str(col).strip() for col in df.columns]

        # 检查必要字段
        required_cols = ["return-date", "sku"]
        missing = [c for c in required_cols if c not in df.columns]
        if missing:
            return {"success": False, "error_message": f"缺少必要字段: {missing}"}

        # 收集日期范围
        all_us_dates = []

        # 先将旧数据标记为非当前
        existing_records = db.execute(
            ReturnAnalysisRecord.__table__.select().where(
                ReturnAnalysisRecord.project_id == project_id,
                ReturnAnalysisRecord.country == country,
            )
        ).fetchall()

        # 获取所有需要处理的 order_id + sku + original_datetime 组合
        new_records_data = []
        for _, row in df.iterrows():
            original_dt_str = str(row.get("return-date", "")).strip()
            original_dt = _parse_iso_datetime_with_timezone(original_dt_str)
            if original_dt is None:
                continue

            us_date = _convert_to_us_date(original_dt)
            all_us_dates.append(us_date)

            order_id = str(row.get("order-id", "")).strip()
            sku = str(row.get("sku", "")).strip()
            asin = str(row.get("asin", "")) if pd.notna(row.get("asin")) else None
            fnsku = str(row.get("fnsku", "")) if pd.notna(row.get("fnsku")) else None
            product_name = (
                str(row.get("product-name", "")) if pd.notna(row.get("product-name")) else None
            )
            quantity = int(row.get("quantity", 1)) if pd.notna(row.get("quantity")) else 1
            fulfillment_center_id = (
                str(row.get("fulfillment-center-id", ""))
                if pd.notna(row.get("fulfillment-center-id"))
                else None
            )
            detailed_disposition = str(row.get("detailed-disposition", "")).strip()
            reason = str(row.get("reason", "")).strip()
            status = str(row.get("status", "")).strip()
            license_plate = (
                str(row.get("license-plate-number", ""))
                if pd.notna(row.get("license-plate-number"))
                else None
            )
            customer_comments = (
                str(row.get("customer-comments", ""))
                if pd.notna(row.get("customer-comments"))
                else ""
            )

            new_records_data.append(
                {
                    "project_id": project_id,
                    "country": country,
                    "return_date": us_date,
                    "order_id": order_id,
                    "sku": sku,
                    "asin": asin,
                    "fnsku": fnsku,
                    "product_name": product_name,
                    "quantity": quantity,
                    "fulfillment_center_id": fulfillment_center_id,
                    "detailed_disposition": detailed_disposition,
                    "reason": reason,
                    "status": status,
                    "license_plate_number": license_plate,
                    "original_return_datetime": original_dt_str,
                    "customer_comments": customer_comments,
                }
            )

        if not new_records_data:
            # 无有效退货记录，以美国时区今天作为标记日期
            marker_date = (
                all_us_dates[0]
                if all_us_dates
                else date.today().isoformat()
            )
            # 检查该日期是否已有标记记录（幂等处理）
            existing = db.execute(
                ReturnAnalysisRecord.__table__.select().where(
                    ReturnAnalysisRecord.project_id == project_id,
                    ReturnAnalysisRecord.country == country,
                    ReturnAnalysisRecord.return_date == marker_date,
                    ReturnAnalysisRecord.order_id == "__MARKER__",
                )
            ).fetchone()
            if existing:
                return {
                    "success": True,
                    "source_id": existing.id,
                    "report_start_date": None,
                    "report_end_date": None,
                    "message": "无有效退货记录，已记录空上传",
                }
            # 插入标记记录，确保 RPA 状态正确显示"已上传（无数据）"
            marker = ReturnAnalysisRecord(
                project_id=project_id,
                country=country,
                return_date=marker_date,
                order_id="__MARKER__",
                sku="__MARKER__",
                asin=None,
                fnsku=None,
                product_name=None,
                quantity=0,
                fulfillment_center_id=None,
                detailed_disposition="__MARKER__",
                reason="__MARKER__",
                status="__MARKER__",
                license_plate_number=None,
                original_return_datetime="1970-01-01T00:00:00+00:00",
                is_current=True,
            )
            db.add(marker)
            db.commit()
            from app.models.report_upload_log import ReportUploadLog
            db.add(ReportUploadLog(
                project_id=project_id,
                report_type="return_report",
                country=country,
                upload_date=date.today(),
                has_real_data=False,
                row_count=0,
                source_file_id=None,
                original_filename=original_filename,
            ))
            db.commit()
            return {
                "success": True,
                "source_id": marker.id,
                "report_start_date": None,
                "report_end_date": None,
                "message": "无有效退货记录，已记录空上传",
            }

        # 完全相同的原始记录在同一文件内只保留一条，避免源文件脏数据重复落库
        seen_record_keys: set[tuple[Any, ...]] = set()

        # 批量插入新数据
        inserted_ids = []
        for record_data in new_records_data:
            comments_text = record_data.pop("customer_comments")
            dedupe_key = (
                record_data["project_id"],
                record_data["country"],
                record_data["return_date"],
                record_data["order_id"],
                record_data["sku"],
                record_data["asin"],
                record_data["fnsku"],
                record_data["product_name"],
                record_data["quantity"],
                record_data["fulfillment_center_id"],
                record_data["detailed_disposition"],
                record_data["reason"],
                record_data["status"],
                record_data["license_plate_number"],
                record_data["original_return_datetime"],
                comments_text,
            )
            if dedupe_key in seen_record_keys:
                continue
            seen_record_keys.add(dedupe_key)

            # 创建退货记录
            record = ReturnAnalysisRecord(**record_data)
            db.add(record)
            db.flush()  # 获取ID

            # 处理顾客评论（独立存储）
            comment_parts = _split_customer_comments(comments_text)
            for comment_text in comment_parts:
                comment_record = ReturnCustomerComment(
                    return_record_id=record.id,
                    sku=record_data["sku"],
                    order_id=record_data["order_id"],
                    customer_comment=comment_text,
                )
                db.add(comment_record)

            inserted_ids.append(record.id)

        db.commit()

        # 写入上传日志
        from app.models.report_upload_log import ReportUploadLog
        db.add(ReportUploadLog(
            project_id=project_id,
            report_type="return_report",
            country=country,
            upload_date=date.today(),
            has_real_data=len(inserted_ids) > 0,
            row_count=len(inserted_ids),
            source_file_id=None,
            original_filename=original_filename,
        ))
        db.commit()

        # 计算日期范围
        report_start_date = min(all_us_dates) if all_us_dates else None
        report_end_date = max(all_us_dates) if all_us_dates else None

        return {
            "success": True,
            "source_id": inserted_ids[0] if inserted_ids else None,
            "report_start_date": report_start_date,
            "report_end_date": report_end_date,
            "message": f"成功入库 {len(inserted_ids)} 条退货记录",
        }

    except Exception as e:
        db.rollback()
        return {"success": False, "error_message": str(e)}


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
    """基于模板生成文字总结"""

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

    # Calculate date range in days
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        date_range_days = (end_dt - start_dt).days + 1
    except Exception:
        date_range_days = max(1, len(trend_rows))

    # Daily avg returns
    daily_avg = round(total_returns / date_range_days, 1) if date_range_days > 0 else 0

    # Industry benchmark: apparel typically 3-8%, general retail < 5%
    industry_benchmark_low = 3.0
    industry_benchmark_high = 8.0

    # Multi-item return rate
    multi_item_rate = (
        round(multi_item_return_count / total_returns * 100, 1) if total_returns > 0 else 0
    )

    # Sales-related metrics
    daily_avg_sales = round(total_sales_quantity / date_range_days, 1) if date_range_days > 0 else 0

    parts: list[str] = []

    # ── 0. 销售概况（新增）───────────────────────────────────────────────────
    if total_sales_quantity > 0:
        parts.append(f"📦 销售概况（{start_date} 至 {end_date}，共 {date_range_days} 天）")
        parts.append(
            f"同周期内共售出 {total_sales_quantity} 件，累计销售额约 ${total_sales_amount:,.2f}，"
            f"日均销售约 {daily_avg_sales} 件。"
        )
        parts.append("")

    # ── 1. 基本概况 ──────────────────────────────────────────────────────────
    parts.append(f"📊 退货概况（{start_date} 至 {end_date}，共 {date_range_days} 天）")
    parts.append(
        f"本周期内共产生 {total_returns} 笔退货，涉及 {total_quantity} 件商品，覆盖 {unique_skus} 个 SKU。"
        f"日均退货约 {daily_avg} 单。"
    )
    # 整体退货率
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

    # ── 2. 高退货 SKU ──────────────────────────────────────────────────────────
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

        # SKU 集中度风险提示
        top3_qty = sum(r.total_quantity for r in ranking_rows[:3])
        if top3_qty > total_quantity * 0.5:
            parts.append(
                f"⚠️ 集中度风险：Top3 SKU 退货量占总量的 {round(top3_qty/total_quantity*100,1)}%，"
                f"退货问题高度集中在这几款产品上。"
            )

    # ── 3. 退货原因 ────────────────────────────────────────────────────────────
    if reason_rows:
        top_reason = reason_rows[0]
        parts.append("")
        parts.append(f"🔍 退货原因分析")
        parts.append(
            f"最主要原因：{top_reason.reason_display}，占全部退货的 {top_reason.percentage}%。"
        )
        if len(reason_rows) > 1:
            parts.append(f"其他主要原因：{top_n(reason_rows[1:], 'return_count', 3)}。")

        # 质量问题提示
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

        # 尺码问题提示
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

        # 描述不符提示
        mismatch_items = [r for r in reason_rows if r.reason == "NOT_AS_DESCRIBED"]
        if mismatch_items and mismatch_items[0].percentage > 5:
            parts.append(
                f"🖼️ 「与描述不符」退货占比 {mismatch_items[0].percentage}%，"
                f"建议核查产品图片、标题及详情页描述是否与实物一致。"
            )

    # ── 4. 多件退货分析 ────────────────────────────────────────────────────────
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

    # ── 5. 趋势分析 ────────────────────────────────────────────────────────────
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

    # ── 6. 星期分布 ────────────────────────────────────────────────────────────
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

    # ── 7. 仓库分布 ───────────────────────────────────────────────────────────
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

    # ── 8. 商品处理状态 ────────────────────────────────────────────────────────
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

    # ── 9. 库存处理进度 ───────────────────────────────────────────────────────
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

    # ── 10. 顾客反馈摘要 ──────────────────────────────────────────────────────
    if feedback_rows:
        # Count feedback per reason
        from collections import Counter
        reason_counter = Counter(r.reason_display for r in feedback_rows)
        top_feedback_reasons = reason_counter.most_common(3)
        total_feedback = len(feedback_rows)
        parts.append("")
        parts.append(f"💬 顾客反馈摘要（共 {total_feedback} 条有评论）")
        for reason, count in top_feedback_reasons:
            pct = round(count / total_feedback * 100, 1)
            parts.append(f"·「{reason}」：{count}条（{pct}%）")
        # Show a sample comment
        if feedback_rows and feedback_rows[0].customer_comment:
            sample = feedback_rows[0].customer_comment[:80]
            parts.append(f"典型反馈：「{sample}{'...' if len(feedback_rows[0].customer_comment) > 80 else ''}」")

    # ── 11. 综合建议 ───────────────────────────────────────────────────────────
    parts.append("")
    parts.append("💡 综合建议")
    suggestions: list[str] = []

    # Reason-based
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

    # SKU concentration
    if ranking_rows and ranking_rows[0].total_quantity > total_quantity * 0.3:
        suggestions.append(
            f"SKU「{ranking_rows[0].sku}」退货量过高（占总量{round(ranking_rows[0].total_quantity/total_quantity*100,1)}%），"
            f"建议单独深度分析该商品并考虑优化listing或临时下架。"
        )

    # Rising trend
    if trend_rows:
        direction, _ = calc_trend(trend_rows)
        if "上升" in direction:
            suggestions.append(
                "退货量呈上升趋势，建议密切关注近期待发货商品质量，必要时加强质检环节。"
            )

    # Pending backlog
    if status_rows and pending and pending.percentage > 30:
        suggestions.append(
            "待处理退货较多，库存积压风险上升，建议加快处理节奏，避免产生额外仓储成本。"
        )

    # Multi-item returns
    if multi_item_rate > 15:
        suggestions.append(
            f"多件退货比例偏高（{multi_item_rate}%），建议抽检相关批次，排除批量性质量缺陷。"
        )

    # Weekend/weekday pattern
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

    # ── 12. 数据说明 ───────────────────────────────────────────────────────────
    parts.append("")
    parts.append(
        f"📋 数据说明：本报告基于 {start_date} 至 {end_date} 共 {date_range_days} 天的退货记录汇总生成。"
        f"日均退货 {daily_avg} 单，覆盖 {unique_skus} 个 SKU。数据仅供参考，实际决策请结合业务情况判断。"
    )

    return "\n".join(parts)


def _safe_rate(numerator: int, denominator: int) -> float:
    """安全计算退货率（百分比）"""
    if denominator <= 0:
        return 0.0
    return round(numerator / denominator * 100, 2)


def _build_sales_aggregates(
    db: Session,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
):
    """
    查询同期销售数据，按 SKU 和日期聚合。

    Returns:
        sku_sales: dict[sku] -> {"quantity": int, "amount": float}
        date_sales: dict[date_str] -> {"quantity": int, "amount": float}
    """
    from app.models import AnalysisSalesOrderRow, AnalysisSourceFile

    # Join: sales_order_row -> source_file -> project_id/country
    from datetime import date

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


def build_return_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None = None,
):
    """
    构建退货分析数据

    Args:
        db: 数据库会话
        project_id: 项目ID
        country: 国家（目前仅US）
        start_date: 开始日期 (YYYY-MM-DD)
        end_date: 结束日期 (YYYY-MM-DD)
        sku: 可选，筛选特定SKU

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

    # 查询退货记录
    query = db.query(ReturnAnalysisRecord).filter(
        ReturnAnalysisRecord.project_id == project_id,
        ReturnAnalysisRecord.country == country,
        ReturnAnalysisRecord.is_current == True,
        ReturnAnalysisRecord.return_date >= start_date,
        ReturnAnalysisRecord.return_date <= end_date,
    )
    if sku:
        query = query.filter(ReturnAnalysisRecord.sku == sku)

    records = query.all()

    # 查询同期销售数据
    sku_sales, date_sales = _build_sales_aggregates(
        db, project_id, country, start_date, end_date
    )

    # 汇总数据
    total_returns = len(records)
    total_quantity = sum(r.quantity for r in records)
    unique_skus = len(set(r.sku for r in records))

    # 高退货排行 - 按SKU聚合（合并销售数据）
    sku_data: dict[str, dict] = {}
    for r in records:
        if r.sku not in sku_data:
            sku_data[r.sku] = {
                "sku": r.sku,
                "asin": r.asin,
                "product_name": r.product_name,
                "total_quantity": 0,
                "return_count": 0,
            }
        sku_data[r.sku]["total_quantity"] += r.quantity
        sku_data[r.sku]["return_count"] += 1

    # 合并销售数据，计算退货率
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
    ranking_rows = ranking_rows[:20]  # Top 20

    # 退货原因分析 - 按reason聚合
    reason_data: dict[str, dict] = {}
    for r in records:
        if r.reason not in reason_data:
            reason_data[r.reason] = {
                "reason": r.reason,
                "total_quantity": 0,
                "return_count": 0,
            }
        reason_data[r.reason]["total_quantity"] += r.quantity
        reason_data[r.reason]["return_count"] += 1

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

    # 退货时间趋势 - 按日期聚合（合并销售数据）
    date_data: dict[str, dict] = {}
    for r in records:
        if r.return_date not in date_data:
            date_data[r.return_date] = {
                "date": r.return_date,
                "total_quantity": 0,
                "return_count": 0,
            }
        date_data[r.return_date]["total_quantity"] += r.quantity
        date_data[r.return_date]["return_count"] += 1

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

    # 商品状态分布 - 按detailed_disposition聚合
    disposition_data: dict[str, dict] = {}
    for r in records:
        if r.detailed_disposition not in disposition_data:
            disposition_data[r.detailed_disposition] = {
                "detailed_disposition": r.detailed_disposition,
                "total_quantity": 0,
                "return_count": 0,
            }
        disposition_data[r.detailed_disposition]["total_quantity"] += r.quantity
        disposition_data[r.detailed_disposition]["return_count"] += 1

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

    # 库存状态分布 - 按status聚合
    status_data: dict[str, dict] = {}
    for r in records:
        if r.status not in status_data:
            status_data[r.status] = {
                "status": r.status,
                "total_quantity": 0,
                "return_count": 0,
            }
        status_data[r.status]["total_quantity"] += r.quantity
        status_data[r.status]["return_count"] += 1

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

    # 顾客反馈 - 获取有评论的记录
    feedback_rows: list[CustomerFeedbackItem] = []
    record_ids = [r.id for r in records]
    if record_ids:
        comments = (
            db.query(ReturnCustomerComment)
            .filter(ReturnCustomerComment.return_record_id.in_(record_ids))
            .all()
        )
        # 建立 record_id -> record 的映射
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

    # ── 星期分布 ────────────────────────────────────────────────────────────────
    from collections import Counter

    weekday_counter: dict[int, int] = Counter()
    for r in records:
        try:
            dt = datetime.strptime(r.return_date, "%Y-%m-%d")
            weekday_counter[dt.weekday()] += 1
        except Exception:
            pass

    weekday_display_map = {0: "周一", 1: "周二", 2: "周三", 3: "周四", 4: "周五", 5: "周六", 6: "周日"}
    weekday_rows = sorted(
        [
            WeekdayItem(
                weekday=w,
                weekday_display=weekday_display_map.get(w, str(w)),
                return_count=c,
                percentage=round(c / total_returns * 100, 2) if total_returns > 0 else 0,
            )
            for w, c in weekday_counter.items()
        ],
        key=lambda x: x.weekday,
    )

    # ── 仓库分布 ──────────────────────────────────────────────────────────────
    fc_counter: dict[str, dict] = {}
    for r in records:
        fc = r.fulfillment_center_id or "未知仓库"
        if fc not in fc_counter:
            fc_counter[fc] = {"return_count": 0, "quantity": 0}
        fc_counter[fc]["return_count"] += 1
        fc_counter[fc]["quantity"] += r.quantity

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

    # ── 多件退货统计 ───────────────────────────────────────────────────────────
    multi_item_return_count = sum(1 for r in records if r.quantity > 1)
    multi_item_return_quantity = sum(r.quantity for r in records if r.quantity > 1)

    # 获取项目名称
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

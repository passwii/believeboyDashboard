"""Return analysis aggregate refresh task (BEL-373 数据层).

每日 03:00 UTC 跑近 90 天增量：
- 对每个 (project, country) 跑近 90 天
- 按 (project, country, sku, data_date) 写一行 aggregate
- 含 Wilson 95% 下界 + risk_level（销量门槛 15 + Wilson 判定）

队列：default（中等规模 SQL 任务，每日一次）。
失败：max_retries=3, retry_backoff=True, retry_backoff_max=300s (5min cap)
回退：endpoint 检测 is_snapshot_fresh_for_range() → 25h 走 fallback build_return_analysis()
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

from celery import shared_task
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.utils.stats import compute_risk_level

logger = logging.getLogger(__name__)


@shared_task(
    name="return_analysis.refresh_daily",
    bind=True,
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=300,
    acks_late=True,
)
def refresh_return_aggregates(
    self, target_date: str | date | None = None
) -> dict[str, Any]:
    """每日刷新 return aggregates 物化表.

    Args:
        target_date: ISO date string (YYYY-MM-DD) 或 date 对象. None = 跑昨天.

    Returns:
        dict with rows_written / projects / target_date
    """
    if isinstance(target_date, str):
        run_date = date.fromisoformat(target_date)
    elif isinstance(target_date, date):
        run_date = target_date
    else:
        run_date = date.today() - timedelta(days=1)

    db = SessionLocal()
    try:
        result = _refresh_one_day(db, target_date=run_date)
        logger.info(
            "return_analysis.refresh_daily 完成：date=%s rows=%d projects=%d",
            run_date.isoformat(),
            result["rows_written"],
            result["projects"],
        )
        return result
    except Exception as exc:
        logger.exception(
            "return_analysis.refresh_daily 失败：date=%s", run_date.isoformat()
        )
        # 让 Celery 重试（max_retries=3, retry_backoff=True）
        raise self.retry(exc=exc)
    finally:
        db.close()


def _refresh_one_day(db: Session, *, target_date: date) -> dict[str, Any]:
    """对单个日期刷新 aggregate.

    流程：
    1. 找出所有 (project_id, country) 有当日退货的项目
    2. 对每个项目拉 raw return rows + sales rows
    3. 按 SKU 重聚合：return_count (unique order+sku) / return_quantity / sales_quantity
    4. UPSERT 到 analysis_return_aggregates（含 Wilson 下界 + risk_level）
    """
    from app.models import (
        AnalysisReturnAggregate,
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
        AnalysisSourceFile,
    )
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    # 1) 找当日有数据的 (project_id, country)
    projects_query = (
        db.query(AnalysisReturnRow.project_id, AnalysisReturnRow.country)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
        )
        .filter(
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,
            AnalysisReturnRow.return_date == target_date,
        )
        .distinct()
        .all()
    )
    if not projects_query:
        return {
            "rows_written": 0,
            "projects": 0,
            "target_date": target_date.isoformat(),
        }

    rows_written = 0
    for project_id, country in projects_query:
        # 2) 拉 raw return rows
        raw_rows = (
            db.query(AnalysisReturnRow)
            .join(
                AnalysisSourceFile,
                AnalysisSourceFile.id == AnalysisReturnRow.source_file_id,
            )
            .filter(
                AnalysisReturnRow.project_id == project_id,
                AnalysisReturnRow.country == country,
                AnalysisSourceFile.report_type == "return_report",
                AnalysisSourceFile.is_current == True,
                AnalysisReturnRow.return_date == target_date,
            )
            .all()
        )
        if not raw_rows:
            continue

        # 3) 拉同日 sales rows
        # BEL-376: sales_quantity 改为"截至 target_date 累计销量"（cumulative）。
        # 原错误使用 == 当日，导致 snapshot 系统性低估销量、退货率虚高。
        # 与 counted_sales_where 一致：排除 Cancelled/Pending + is_counted_sales=true。
        sales_rows = (
            db.query(
                AnalysisSalesOrderRow.sku,
                AnalysisSalesOrderRow.quantity,
            )
            .filter(
                AnalysisSalesOrderRow.project_id == project_id,
                AnalysisSalesOrderRow.country == country,
                AnalysisSalesOrderRow.purchase_date_pt <= target_date,
                AnalysisSalesOrderRow.is_counted_sales == True,
                AnalysisSalesOrderRow.order_status != "Cancelled",
                AnalysisSalesOrderRow.order_status != "Pending",
            )
            .all()
        )
        # SKU → 当日 sales 总量
        sales_by_sku: dict[str, int] = Counter()
        for r in sales_rows:
            if r.sku:
                sales_by_sku[r.sku] += r.quantity

        # 4) 按 SKU 聚合
        sku_data: dict[str, dict] = {}
        for r in raw_rows:
            sku = r.sku
            if sku not in sku_data:
                sku_data[sku] = {
                    "asin": r.asin,
                    "return_count": 0,  # unique (order_id, sku)
                    "return_quantity": 0,
                    "unique_keys": set(),
                    "reason_counter": Counter(),
                    "disposition_counter": Counter(),
                    "fc_counter": Counter(),
                    "cycle_days": [],
                }
            agg = sku_data[sku]
            agg["return_quantity"] += r.quantity
            agg["unique_keys"].add((r.order_id, sku))
            agg["reason_counter"][r.reason] += 1
            agg["disposition_counter"][r.detailed_disposition] += 1
            if r.fulfillment_center_id:
                agg["fc_counter"][r.fulfillment_center_id] += 1
            # cycle_days 由外部查询（避免此处复杂 join），本次实现简化为 None

        # 5) 写 aggregate（UPSERT）
        aggregate_rows: list[dict] = []
        for sku, v in sku_data.items():
            return_count = len(v["unique_keys"])
            return_quantity = v["return_quantity"]
            sales_quantity = sales_by_sku.get(sku, 0)
            return_rate = (
                round(return_quantity / sales_quantity * 100, 3)
                if sales_quantity > 0
                else 0.0
            )
            risk_level, wilson_lower = compute_risk_level(
                return_quantity, sales_quantity
            )
            reason_top1, reason_count = (
                v["reason_counter"].most_common(1)[0]
                if v["reason_counter"]
                else (None, 0)
            )
            reason_top1_pct = (
                round(reason_count / return_count * 100, 2) if return_count > 0 else 0.0
            )
            disposition_top1 = (
                v["disposition_counter"].most_common(1)[0][0]
                if v["disposition_counter"]
                else None
            )
            dominant_fc_id = (
                v["fc_counter"].most_common(1)[0][0] if v["fc_counter"] else None
            )
            aggregate_rows.append(
                {
                    "project_id": project_id,
                    "country": country,
                    "sku": sku,
                    "asin": v["asin"],
                    "data_date": target_date,
                    "return_count": return_count,
                    "return_quantity": return_quantity,
                    "sales_quantity": sales_quantity,
                    "return_rate": return_rate,
                    "cycle_avg_days": None,
                    "cycle_min_days": None,
                    "cycle_max_days": None,
                    "reason_top1": reason_top1,
                    "reason_top1_pct": reason_top1_pct,
                    "reason_top1_display": None,  # 由 endpoint 端翻译
                    "disposition_top1": disposition_top1,
                    "disposition_top1_display": None,
                    "dominant_fc_id": dominant_fc_id,
                    "risk_level": risk_level,
                    "wilson_lower": round(wilson_lower, 3) if wilson_lower else None,
                    "data_version": 2,  # BEL-376: cumulative-sales semantics (was 1 = same-day)
                    "computed_at": datetime.now(timezone.utc),
                }
            )

        # UPSERT（PG 用 ON CONFLICT；SQLite 用 OR REPLACE）
        if aggregate_rows:
            bind = db.get_bind()
            dialect_name = bind.dialect.name if bind else "postgresql"
            stmt = pg_insert(AnalysisReturnAggregate).values(aggregate_rows)
            if dialect_name == "postgresql":
                stmt = stmt.on_conflict_do_update(
                    constraint="uq_return_agg_project_country_sku_date",
                    set_={
                        "asin": stmt.excluded.asin,
                        "return_count": stmt.excluded.return_count,
                        "return_quantity": stmt.excluded.return_quantity,
                        "sales_quantity": stmt.excluded.sales_quantity,
                        "return_rate": stmt.excluded.return_rate,
                        "reason_top1": stmt.excluded.reason_top1,
                        "reason_top1_pct": stmt.excluded.reason_top1_pct,
                        "disposition_top1": stmt.excluded.disposition_top1,
                        "dominant_fc_id": stmt.excluded.dominant_fc_id,
                        "risk_level": stmt.excluded.risk_level,
                        "wilson_lower": stmt.excluded.wilson_lower,
                        "data_version": AnalysisReturnAggregate.data_version + 1,
                        "computed_at": stmt.excluded.computed_at,
                    },
                )
            else:
                # SQLite fallback (tests use sqlite in-memory)
                stmt = sqlite_insert(AnalysisReturnAggregate).values(aggregate_rows)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["project_id", "country", "sku", "data_date"],
                    set_={
                        "asin": stmt.excluded.asin,
                        "return_count": stmt.excluded.return_count,
                        "return_quantity": stmt.excluded.return_quantity,
                        "sales_quantity": stmt.excluded.sales_quantity,
                        "return_rate": stmt.excluded.return_rate,
                        "reason_top1": stmt.excluded.reason_top1,
                        "reason_top1_pct": stmt.excluded.reason_top1_pct,
                        "disposition_top1": stmt.excluded.disposition_top1,
                        "dominant_fc_id": stmt.excluded.dominant_fc_id,
                        "risk_level": stmt.excluded.risk_level,
                        "wilson_lower": stmt.excluded.wilson_lower,
                        "data_version": AnalysisReturnAggregate.data_version + 1,
                        "computed_at": stmt.excluded.computed_at,
                    },
                )
            db.execute(stmt)
            rows_written += len(aggregate_rows)

    db.commit()
    return {
        "rows_written": rows_written,
        "projects": len(projects_query),
        "target_date": target_date.isoformat(),
    }

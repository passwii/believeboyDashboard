"""Return analysis aggregate refresh task (BEL-373 数据层, BLF-805 根治).

每日 03:00 CST（beat 时区 Asia/Shanghai）跑「回看窗口 + 缺口补齐」：
- 回看近 DEFAULT_LOOKBACK_DAYS 天（含昨天）逐日重算，UPSERT 幂等覆盖
  退货报表 ~08:11 才入库（内容截至前一天）导致的入库延迟；
- 缺口补齐：raw 层存在但快照缺行的更早日期一并重算（自愈长时停机/漏跑，
  上限 MAX_GAP_BACKFILL_DAYS 天，更早的走 return-analysis-rebuild 全量重建）；
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
from app.services.infra.cache_decorator import (
    invalidate_cache_on_commit_celery,
    mark_committed,
)
from app.utils.stats import compute_risk_level

logger = logging.getLogger(__name__)

# BLF-805: 每日回看窗口。退货报表 ~08:11 CST 入库（内容截至前一天），而 beat 在
# 03:00 跑——单日增量永远跑在数据到达之前且无补算机制，导致快照表自 2026-08-03
# 起冻结。7 天窗口覆盖最大入库延迟与短时漏跑；更长的缺口由缺口补齐 + rebuild 兜底。
DEFAULT_LOOKBACK_DAYS = 7

# 缺口补齐扫描下界（天）：只自动补近一年的缺口，更早的走全量重建端点。
MAX_GAP_BACKFILL_DAYS = 366


def _find_gap_dates(db: Session, *, window_start: date) -> list[date]:
    """找「raw 有退货事件但快照缺行/旧行」的日期（早于回看窗口的部分）.

    判定粒度：(project_id, country, return_date) 三元组在快照表无对应行，
    或对应行还是没写 daily_sales_quantity 的迁移前旧行（BLF-806：NULL 视为
    待重算，靠每日任务自愈补齐，无需手工数据迁移）。
    返回去重后的日期列表（升序）。扫描范围限制在 MAX_GAP_BACKFILL_DAYS 内，
    避免极端情况（如整表被清）下单次任务静默跑出一次全量重建的耗时。
    """
    from sqlalchemy import text

    scan_floor = date.today() - timedelta(days=MAX_GAP_BACKFILL_DAYS)
    rows = db.execute(
        text(
            """
            SELECT DISTINCT r.return_date
            FROM analysis_return_rows r
            JOIN analysis_source_files f ON f.id = r.source_file_id
            LEFT JOIN analysis_return_aggregates a
                ON a.project_id = r.project_id
               AND a.country = r.country
               AND a.data_date = r.return_date
               AND a.daily_sales_quantity IS NOT NULL
            WHERE f.report_type = 'return_report'
              AND f.is_current = TRUE
              AND r.return_date < :window_start
              AND r.return_date >= :scan_floor
              AND a.id IS NULL
            ORDER BY r.return_date
            """
        ),
        {"window_start": window_start, "scan_floor": scan_floor},
    ).all()
    return [row[0] for row in rows]


@shared_task(
    name="return_analysis.refresh_daily",
    bind=True,
    max_retries=3,
    retry_backoff=True,
    retry_backoff_max=300,
    acks_late=True,
)
@invalidate_cache_on_commit_celery(
    domains=["return_analysis"],
    project_id_from="global",
    on_error="log",
)
def refresh_return_aggregates(
    self,
    target_date: str | date | None = None,
    lookback_days: int | None = None,
) -> dict[str, Any]:
    """每日刷新 return aggregates 物化表（BLF-805：回看窗口 + 缺口补齐）.

    Args:
        target_date: ISO date string (YYYY-MM-DD) 或 date 对象. None = 窗口止于昨天.
            显式传入时窗口止于该日（手动补跑/测试用）。
        lookback_days: 回看天数（含 target_date），默认 DEFAULT_LOOKBACK_DAYS=7。

    Returns:
        dict with rows_written / projects / target_date / range_start /
        range_end / days_processed / backfilled_dates
    """
    if isinstance(target_date, str):
        window_end = date.fromisoformat(target_date)
    elif isinstance(target_date, date):
        window_end = target_date
    else:
        window_end = date.today() - timedelta(days=1)

    days = lookback_days if lookback_days is not None else DEFAULT_LOOKBACK_DAYS
    days = max(1, min(days, 90))
    window_start = window_end - timedelta(days=days - 1)

    db = SessionLocal()
    try:
        # 1) 缺口补齐：raw 有而快照缺的更早日期（自愈停机/漏跑）
        gap_dates = _find_gap_dates(db, window_start=window_start)
        window_dates = {window_start + timedelta(days=i) for i in range(days)}
        all_dates = sorted(set(gap_dates) | window_dates)

        # 2) 逐日重算（_refresh_one_day 幂等 UPSERT + 单日 commit）
        rows_written = 0
        max_projects = 0
        for run_date in all_dates:
            result = _refresh_one_day(db, target_date=run_date)
            rows_written += result["rows_written"]
            max_projects = max(max_projects, result["projects"])

        mark_committed()  # BLF-668: _refresh_one_day 内部已 commit，按协议标记
        logger.info(
            "return_analysis.refresh_daily 完成：range=%s..%s rows=%d projects=%d "
            "days=%d backfilled=%s",
            window_start.isoformat(),
            window_end.isoformat(),
            rows_written,
            max_projects,
            len(all_dates),
            [d.isoformat() for d in gap_dates] or "[]",
        )
        return {
            "rows_written": rows_written,
            "projects": max_projects,
            "target_date": window_end.isoformat(),
            "range_start": window_start.isoformat(),
            "range_end": window_end.isoformat(),
            "days_processed": len(all_dates),
            "backfilled_dates": [d.isoformat() for d in gap_dates],
        }
    except Exception as exc:
        logger.exception(
            "return_analysis.refresh_daily 失败：range=%s..%s",
            window_start.isoformat(),
            window_end.isoformat(),
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

        # 3) 拉截至当日 sales rows（一次查询同时算累计与当日两个口径）
        # BEL-376: sales_quantity = "截至 target_date 累计销量"（cumulative，
        # audit 用）；BLF-806: daily_sales_quantity = 当日销量，供读侧按窗口
        # SUM 出与 R1 counted-sales 同口径的销量。
        # 与 counted_sales_where 一致：排除 Cancelled/Pending + is_counted_sales=true。
        sales_rows = (
            db.query(
                AnalysisSalesOrderRow.sku,
                AnalysisSalesOrderRow.quantity,
                AnalysisSalesOrderRow.purchase_date_pt,
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
        # SKU → 截至当日累计 / 当日 销量
        cumulative_by_sku: dict[str, int] = Counter()
        daily_by_sku: dict[str, int] = Counter()
        for r in sales_rows:
            if not r.sku:
                continue
            cumulative_by_sku[r.sku] += r.quantity
            if r.purchase_date_pt == target_date:
                daily_by_sku[r.sku] += r.quantity

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
            sales_quantity = cumulative_by_sku.get(sku, 0)
            daily_sales_quantity = daily_by_sku.get(sku, 0)
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
                    "daily_sales_quantity": daily_sales_quantity,
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
                    "data_version": 3,  # BLF-806: +daily_sales_quantity（2 = BEL-376 cumulative-only）
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
                        "daily_sales_quantity": stmt.excluded.daily_sales_quantity,
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
                        "daily_sales_quantity": stmt.excluded.daily_sales_quantity,
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

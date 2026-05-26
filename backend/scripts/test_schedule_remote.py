#!/usr/bin/env python3
"""
远程数据库聚合查询压力测试 — 纯数据查询，不含AI管线
目标: 145.79.143.98:5432/BLF (Xeon Platinum + 2G RAM)
逐步递增并发: 20 → 50 → 100，验证数据库连接池是否被打满
"""
from __future__ import annotations

import concurrent.futures
import logging
import sys
import threading
import time
from datetime import date, timedelta

sys.path.insert(0, "/Users/damon/DamonProjects/believeboyDashboard/backend")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("remote_agg")

REMOTE_DATABASE_URL = "postgresql+psycopg://damon:jrway2012@145.79.143.98:5432/BLF"


def _create_remote_engine():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        REMOTE_DATABASE_URL,
        pool_pre_ping=True,
        pool_size=20,
        max_overflow=30,
        pool_recycle=1800,
        pool_timeout=30,
        connect_args={"connect_timeout": 30},
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, SessionLocal


def get_pool_status(engine):
    pool = engine.pool
    return {
        "pool_size": pool.size(),
        "checked_out": pool.checkedout(),
        "overflow": getattr(pool, "_overflow", 0),
    }


def log_pool_status(engine, label=""):
    s = get_pool_status(engine)
    avail = s["pool_size"] + s["overflow"] - s["checked_out"]
    logger.info(f"[POOL {label}] size={s['pool_size']} in_use={s['checked_out']} available={avail} overflow={s['overflow']}")


def run_aggregate_queries(db):
    from sqlalchemy import func
    from app.models import (
        AnalysisAdProductRow,
        AnalysisReturnRow,
        AnalysisSalesOrderRow,
        AnalysisSourceFile,
        InventorySnapshotRow,
    )

    today = date.today() - timedelta(days=1)
    period_start = today - timedelta(days=6)
    country = "US"
    results = {}

    q1 = (
        db.query(
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0).label("qty"),
            func.coalesce(
                func.sum(
                    func.coalesce(AnalysisSalesOrderRow.item_price, 0)
                    + func.coalesce(AnalysisSalesOrderRow.shipping_price, 0)
                ),
                0,
            ).label("amount"),
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
        .filter(
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.purchase_date_pt >= period_start,
            AnalysisSalesOrderRow.purchase_date_pt <= today,
        )
    )
    row = q1.first()
    results["sales"] = {"qty": int(row.qty) if row else 0, "amount": float(row.amount) if row else 0}

    q2 = (
        db.query(
            AnalysisSalesOrderRow.sku,
            func.sum(AnalysisSalesOrderRow.quantity).label("total_qty"),
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
        .filter(
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSalesOrderRow.purchase_date_pt >= period_start,
            AnalysisSalesOrderRow.purchase_date_pt <= today,
        )
        .group_by(AnalysisSalesOrderRow.sku)
        .order_by(func.sum(AnalysisSalesOrderRow.quantity).desc())
        .limit(5)
    )
    results["top_skus"] = [{"sku": r.sku, "qty": int(r.total_qty)} for r in q2.all()]

    q3 = (
        db.query(
            InventorySnapshotRow.sku,
            InventorySnapshotRow.available_qty,
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == InventorySnapshotRow.source_file_id)
        .filter(
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.is_current == True,
            InventorySnapshotRow.available_qty <= 10,
        )
        .order_by(InventorySnapshotRow.available_qty.asc())
        .limit(20)
    )
    results["inventory"] = [{"sku": r.sku, "qty": int(r.available_qty)} for r in q3.all()]

    q4 = (
        db.query(
            func.coalesce(func.sum(AnalysisAdProductRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AnalysisAdProductRow.sales_7d), 0).label("sales"),
            func.coalesce(func.sum(AnalysisAdProductRow.clicks), 0).label("clicks"),
            func.coalesce(func.sum(AnalysisAdProductRow.impressions), 0).label("impressions"),
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisAdProductRow.source_file_id)
        .filter(
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "ad_product_report",
            AnalysisSourceFile.is_current == True,
            AnalysisSourceFile.period_end_date == today,
        )
    )
    row = q4.first()
    results["ads"] = {
        "spend": float(row.spend) if row else 0,
        "sales": float(row.sales) if row else 0,
        "clicks": int(row.clicks) if row else 0,
        "impressions": int(row.impressions) if row else 0,
    }

    q5 = (
        db.query(
            AnalysisReturnRow.reason,
            func.count().label("cnt"),
            func.sum(AnalysisReturnRow.quantity).label("total_qty"),
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisReturnRow.source_file_id)
        .filter(
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "return_report",
            AnalysisSourceFile.is_current == True,
            AnalysisReturnRow.return_date >= period_start,
            AnalysisReturnRow.return_date <= today,
            AnalysisReturnRow.reason.isnot(None),
            AnalysisReturnRow.reason != "",
        )
        .group_by(AnalysisReturnRow.reason)
        .order_by(func.count().desc())
        .limit(3)
    )
    results["returns"] = [{"reason": r.reason, "qty": int(r.total_qty)} for r in q5.all()]

    return results


def execute_aggregate(sid, engine, SessionLocal):
    start = time.time()
    try:
        db = SessionLocal()
        try:
            run_aggregate_queries(db)
        finally:
            db.close()
        elapsed = time.time() - start
        return {"sid": sid, "success": True, "elapsed": elapsed}
    except Exception as e:
        logger.error(f"[Agg-{sid}] FAILED: {e}")
        return {"sid": sid, "success": False, "error": str(e), "elapsed": time.time() - start}


def run_benchmark(label, count, workers, engine, SessionLocal):
    logger.info("")
    logger.info("=" * 60)
    logger.info(f"🧪 {label}")
    logger.info(f"   并发数: {count}, Worker: {workers}")
    logger.info("=" * 60)

    log_pool_status(engine, "BEFORE")
    start_time = time.time()
    results = []
    lock = threading.Lock()
    peak_conn = 0
    start_times = {}
    end_times = {}

    def wrapped(sid):
        nonlocal peak_conn
        start_times[sid] = time.time()
        r = execute_aggregate(sid, engine, SessionLocal)
        end_times[sid] = time.time()
        s = get_pool_status(engine)
        with lock:
            peak_conn = max(peak_conn, s["checked_out"])
        return r

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(wrapped, i): i for i in range(count)}
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                results.append({"sid": futures[future], "success": False, "error": str(e)})

    total_time = time.time() - start_time
    log_pool_status(engine, "AFTER")

    success_count = sum(1 for r in results if r.get("success"))
    failed_count = len(results) - success_count
    elapsed_list = [r.get("elapsed", 0) for r in results]
    avg_time = sum(elapsed_list) / len(elapsed_list) if elapsed_list else 0
    max_time = max(elapsed_list) if elapsed_list else 0
    min_time = min(elapsed_list) if elapsed_list else 0
    p95 = sorted(elapsed_list)[int(len(elapsed_list) * 0.95)] if elapsed_list else 0
    p99 = sorted(elapsed_list)[int(len(elapsed_list) * 0.99)] if elapsed_list else 0

    all_starts = sorted(start_times.values())
    all_ends = sorted(end_times.values())
    if all_starts and all_ends:
        window = max(all_ends) - min(all_starts)
    else:
        window = total_time

    logger.info("-" * 60)
    logger.info(f"📊 {label} 统计:")
    logger.info(f"   并发窗口:     {window:.2f}s （从第1个开始到最后1个结束）")
    logger.info(f"   总耗时:       {total_time:.2f}s")
    logger.info(f"   成功/失败:    {success_count}/{failed_count}")
    logger.info(f"   平均耗时:     {avg_time:.2f}s")
    logger.info(f"   最快/最慢:    {min_time:.2f}s / {max_time:.2f}s")
    logger.info(f"   P95/P99:      {p95:.2f}s / {p99:.2f}s")
    logger.info(f"   峰值连接:     {peak_conn} (pool={get_pool_status(engine)['pool_size']}+overflow={get_pool_status(engine)['overflow']})")
    logger.info("=" * 60)

    return {
        "label": label,
        "count": count,
        "workers": workers,
        "success": success_count,
        "failed": failed_count,
        "total_time": total_time,
        "avg_time": avg_time,
        "min_time": min_time,
        "max_time": max_time,
        "p95_time": p95,
        "p99_time": p99,
        "peak_connections": peak_conn,
        "window": window,
    }


def main():
    logger.info("🚀 远程数据库聚合查询压力测试（纯数据查询）")
    logger.info(f"   目标: {REMOTE_DATABASE_URL.replace('jrway2012', '***')}")
    logger.info(f"   硬件: Xeon Platinum + 2G RAM")
    logger.info(f"   Pool: size=20, overflow=30 (max=50)")
    logger.info("")

    engine, SessionLocal = _create_remote_engine()
    logger.info("✅ 远程数据库连接成功")

    results = []

    results.append(run_benchmark("20 并发聚合查询", 20, 10, engine, SessionLocal))
    time.sleep(3)

    results.append(run_benchmark("50 并发聚合查询", 50, 20, engine, SessionLocal))
    time.sleep(3)

    results.append(run_benchmark("100 并发聚合查询", 100, 30, engine, SessionLocal))

    logger.info("")
    logger.info("📋 远程数据库测试结果汇总")
    logger.info("-" * 120)
    logger.info(f"{'测试场景':<25} {'并发':>5} {'成功':>4} {'失败':>4} {'窗口':>8} {'平均':>7} {'P95':>7} {'P99':>7} {'峰值连接':>8}")
    logger.info("-" * 120)
    for r in results:
        logger.info(
            f"{r['label']:<25} {r['count']:>5} {r['success']:>4} {r['failed']:>4} "
            f"{r['window']:>7.1f}s {r['avg_time']:>6.2f}s {r['p95_time']:>6.2f}s {r['p99_time']:>6.2f}s {r['peak_connections']:>8}"
        )
    logger.info("-" * 120)

    peak = max(r["peak_connections"] for r in results)
    logger.info("")
    if peak >= 45:
        logger.info(f"⚠️ 峰值连接 {peak}/50 — 连接池接近打满，数据库或网络已成为瓶颈")
    elif peak >= 30:
        logger.info(f"⚡ 峰值连接 {peak}/50 — 数据库压力较大，但尚未打满")
    else:
        logger.info(f"✅ 峰值连接 {peak}/50 — 数据库仍有较大余量")

    engine.dispose()
    logger.info("✅ 测试完成，连接池已释放")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Schedule Report 远程数据库压力测试
目标: 145.79.143.98:5432/BLF (Xeon Platinum + 2G RAM)
并发: 100 订阅 × 16 Worker
包含聚合数据测试 + 管线测试
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
logger = logging.getLogger("remote_stress")

REMOTE_DATABASE_URL = "postgresql+psycopg://damon:jrway2012@145.79.143.98:5432/BLF"
AI_CONCURRENCY_LIMIT = 2
_ai_semaphore = threading.Semaphore(AI_CONCURRENCY_LIMIT)
AI_BUILD_DELAY = 3.0


def _create_remote_engine():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        REMOTE_DATABASE_URL,
        pool_pre_ping=True,
        pool_size=20,
        max_overflow=20,
        pool_recycle=1800,
        pool_timeout=10,
        connect_args={"connect_timeout": 10},
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


def _run_aggregate_queries(db):
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


def test_aggregate_only(sid, engine, SessionLocal):
    start = time.time()
    try:
        db = SessionLocal()
        try:
            _run_aggregate_queries(db)
        finally:
            db.close()
        return {"sid": sid, "success": True, "elapsed": time.time() - start}
    except Exception as e:
        logger.error(f"[Agg-{sid}] FAILED: {e}")
        return {"sid": sid, "success": False, "error": str(e), "elapsed": time.time() - start}


def test_dispatch_pipeline(sid, engine, SessionLocal):
    start = time.time()
    try:
        db1 = SessionLocal()
        try:
            time.sleep(0.01)
        finally:
            db1.close()

        sem_start = time.time()
        _ai_semaphore.acquire()
        sem_wait = time.time() - sem_start

        try:
            db2 = SessionLocal()
            try:
                _run_aggregate_queries(db2)
                time.sleep(AI_BUILD_DELAY)
            finally:
                db2.close()
        finally:
            _ai_semaphore.release()

        db3 = SessionLocal()
        try:
            time.sleep(0.01)
        finally:
            db3.close()

        return {
            "sid": sid,
            "success": True,
            "elapsed": time.time() - start,
            "semaphore_wait": sem_wait,
        }
    except Exception as e:
        logger.error(f"[Pipe-{sid}] FAILED: {e}")
        return {"sid": sid, "success": False, "error": str(e), "elapsed": time.time() - start}


def run_benchmark(name, test_func, count, workers, engine, SessionLocal):
    logger.info("")
    logger.info("=" * 60)
    logger.info(f"🧪 {name}")
    logger.info(f"   订阅数: {count}, Worker: {workers}")
    logger.info("=" * 60)

    log_pool_status(engine, "BEFORE")
    start_time = time.time()
    results = []
    lock = threading.Lock()
    peak_conn = 0

    def wrapped(sid):
        nonlocal peak_conn
        r = test_func(sid, engine, SessionLocal)
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
    p95 = sorted(elapsed_list)[int(len(elapsed_list) * 0.95)] if elapsed_list else 0

    waits = [r.get("semaphore_wait", 0) for r in results if r.get("success")]
    avg_wait = sum(waits) / len(waits) if waits else 0
    max_wait = max(waits) if waits else 0

    logger.info("-" * 60)
    logger.info(f"📊 {name} 统计:")
    logger.info(f"   总耗时:       {total_time:.2f}s")
    logger.info(f"   成功/失败:    {success_count}/{failed_count}")
    logger.info(f"   平均耗时:     {avg_time:.2f}s")
    logger.info(f"   P95 耗时:     {p95:.2f}s")
    logger.info(f"   吞吐量:       {len(results)/total_time:.2f} 订阅/秒")
    logger.info(f"   峰值连接:     {peak_conn}")
    if waits:
        logger.info(f"   AI等待(avg):  {avg_wait:.2f}s")
        logger.info(f"   AI等待(max):  {max_wait:.2f}s")
    logger.info("=" * 60)

    return {
        "name": name,
        "total": count,
        "success": success_count,
        "failed": failed_count,
        "total_time": total_time,
        "avg_time": avg_time,
        "max_time": max_time,
        "p95_time": p95,
        "throughput": len(results) / total_time if total_time > 0 else 0,
        "peak_connections": peak_conn,
        "avg_semaphore_wait": avg_wait,
        "max_semaphore_wait": max_wait,
    }


def main():
    logger.info("🚀 远程数据库压力测试")
    logger.info(f"   目标: {REMOTE_DATABASE_URL.replace('jrway2012', '***')}")
    logger.info(f"   硬件: Xeon Platinum + 2G RAM")
    logger.info(f"   AI Semaphore: {AI_CONCURRENCY_LIMIT}, AI 延迟: {AI_BUILD_DELAY}s")
    logger.info("")

    engine, SessionLocal = _create_remote_engine()
    logger.info("✅ 远程数据库连接成功")

    results = []

    # 聚合数据测试 (100 × 16)
    results.append(run_benchmark(
        "远程 100 聚合数据测试",
        test_aggregate_only,
        100, 16,
        engine, SessionLocal,
    ))
    time.sleep(2)

    # 管线测试 (100 × 16)
    results.append(run_benchmark(
        "远程 100 管线测试",
        test_dispatch_pipeline,
        100, 16,
        engine, SessionLocal,
    ))

    # 汇总
    logger.info("")
    logger.info("📋 远程数据库测试结果汇总")
    logger.info("-" * 90)
    logger.info(f"{'测试名称':<25} {'总':>5} {'成':>4} {'败':>4} {'总耗时':>8} {'平均':>7} {'P95':>7} {'峰值连接':>8}")
    logger.info("-" * 90)
    for r in results:
        logger.info(
            f"{r['name']:<25} {r['total']:>5} {r['success']:>4} {r['failed']:>4} "
            f"{r['total_time']:>7.1f}s {r['avg_time']:>6.2f}s {r['p95_time']:>6.2f}s {r['peak_connections']:>8}"
        )
    logger.info("-" * 90)

    engine.dispose()
    logger.info("✅ 远程数据库测试完成，连接池已释放")


if __name__ == "__main__":
    main()

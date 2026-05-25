#!/usr/bin/env python3
"""
远程数据库低并发验证测试
策略：20并发，connect_timeout=30，避免连接风暴
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
logger = logging.getLogger("remote_low")

REMOTE_URL = "postgresql+psycopg://damon:jrway2012@145.79.143.98:5432/BLF"
AI_CONCURRENCY_LIMIT = 2
_ai_semaphore = threading.Semaphore(AI_CONCURRENCY_LIMIT)
AI_BUILD_DELAY = 3.0


def _create_engine():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(
        REMOTE_URL,
        pool_pre_ping=True,
        pool_size=20,
        max_overflow=20,
        pool_recycle=1800,
        pool_timeout=30,
        connect_args={"connect_timeout": 30},
    )
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, SessionLocal


def get_pool_status(engine):
    pool = engine.pool
    return {
        "checked_out": pool.checkedout(),
        "size": pool.size(),
        "overflow": getattr(pool, "_overflow", 0),
    }


def _run_queries(db):
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
    sales_qty = int(row.qty) if row else 0

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
    top_skus = q2.all()

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
    inventory = q3.all()

    q4 = (
        db.query(
            func.coalesce(func.sum(AnalysisAdProductRow.spend), 0).label("spend"),
            func.coalesce(func.sum(AnalysisAdProductRow.sales_7d), 0).label("sales"),
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
    ad_spend = float(row.spend) if row else 0

    q5 = (
        db.query(
            AnalysisReturnRow.reason,
            func.count().label("cnt"),
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
    returns = q5.all()

    return {
        "sales_qty": sales_qty,
        "top_skus_count": len(top_skus),
        "inventory_count": len(inventory),
        "ad_spend": ad_spend,
        "returns_count": len(returns),
    }


def test_agg(sid, engine, SessionLocal):
    start = time.time()
    try:
        db = SessionLocal()
        try:
            _run_queries(db)
        finally:
            db.close()
        return {"sid": sid, "success": True, "elapsed": time.time() - start}
    except Exception as e:
        logger.error(f"[Agg-{sid}] FAILED: {e}")
        return {"sid": sid, "success": False, "error": str(e), "elapsed": time.time() - start}


def test_pipe(sid, engine, SessionLocal):
    start = time.time()
    sem_wait = 0.0
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
                _run_queries(db2)
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

        return {"sid": sid, "success": True, "elapsed": time.time() - start, "semaphore_wait": sem_wait}
    except Exception as e:
        logger.error(f"[Pipe-{sid}] FAILED: {e}")
        return {"sid": sid, "success": False, "error": str(e), "elapsed": time.time() - start}


def run_test(name, func, count, workers, engine, SessionLocal):
    logger.info("")
    logger.info("=" * 60)
    logger.info(f"🧪 {name}")
    logger.info(f"   订阅: {count}, Worker: {workers}")
    logger.info("=" * 60)

    s = get_pool_status(engine)
    logger.info(f"[POOL BEFORE] in_use={s['checked_out']} size={s['size']}")

    start_time = time.time()
    results = []
    lock = threading.Lock()
    peak_conn = 0

    def wrapped(sid):
        nonlocal peak_conn
        r = func(sid, engine, SessionLocal)
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
    s = get_pool_status(engine)
    logger.info(f"[POOL AFTER] in_use={s['checked_out']} size={s['size']}")

    success = sum(1 for r in results if r.get("success"))
    failed = len(results) - success
    elapsed_list = [r.get("elapsed", 0) for r in results]
    avg_time = sum(elapsed_list) / len(elapsed_list) if elapsed_list else 0
    p95 = sorted(elapsed_list)[int(len(elapsed_list) * 0.95)] if elapsed_list else 0

    waits = [r.get("semaphore_wait", 0) for r in results if r.get("success")]
    avg_wait = sum(waits) / len(waits) if waits else 0

    logger.info("-" * 60)
    logger.info(f"📊 {name}:")
    logger.info(f"   总耗时:     {total_time:.2f}s")
    logger.info(f"   成功/失败:  {success}/{failed}")
    logger.info(f"   平均:       {avg_time:.2f}s")
    logger.info(f"   P95:        {p95:.2f}s")
    logger.info(f"   吞吐量:     {len(results)/total_time:.2f}/s")
    logger.info(f"   峰值连接:   {peak_conn}")
    if waits:
        logger.info(f"   AI等待:     {avg_wait:.2f}s")
    logger.info("=" * 60)

    return {
        "name": name, "total": count, "success": success, "failed": failed,
        "total_time": total_time, "avg_time": avg_time, "p95_time": p95,
        "throughput": len(results)/total_time if total_time > 0 else 0,
        "peak_conn": peak_conn, "avg_wait": avg_wait,
    }


def main():
    logger.info("🚀 远程数据库低并发验证 (20并发)")
    logger.info(f"   网络延迟: ~227ms RTT, 丢包 33%")
    logger.info(f"   策略: connect_timeout=30, pool_size=20, max_overflow=20")
    logger.info("")

    engine, SessionLocal = _create_engine()
    logger.info("✅ 远程连接成功")

    results = []

    # 20 聚合
    results.append(run_test("远程 20 聚合测试", test_agg, 20, 8, engine, SessionLocal))
    time.sleep(2)

    # 20 管线
    results.append(run_test("远程 20 管线测试", test_pipe, 20, 8, engine, SessionLocal))

    # 30 聚合
    time.sleep(2)
    results.append(run_test("远程 30 聚合测试", test_agg, 30, 10, engine, SessionLocal))

    # 汇总
    logger.info("")
    logger.info("📋 远程低并发测试结果")
    logger.info("-" * 80)
    logger.info(f"{'测试':<25} {'总':>5} {'成':>4} {'败':>4} {'耗时':>8} {'平均':>7} {'P95':>7} {'峰值连接':>8}")
    logger.info("-" * 80)
    for r in results:
        logger.info(
            f"{r['name']:<25} {r['total']:>5} {r['success']:>4} {r['failed']:>4} "
            f"{r['total_time']:>7.1f}s {r['avg_time']:>6.2f}s {r['p95_time']:>6.2f}s {r['peak_conn']:>8}"
        )
    logger.info("-" * 80)

    engine.dispose()
    logger.info("✅ 测试完成")


if __name__ == "__main__":
    main()

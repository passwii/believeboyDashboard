#!/usr/bin/env python3
"""
远程数据库低并发联通性验证测试（纯数据查询）
策略：20/30 并发，connect_timeout=30，验证连通性和基本性能

连接优先级：env `PROD_DATABASE_URL` 优先（无则用 backend/.env），
无值则退出。源码不硬编码生产端 IP——见 [BEL-75]。
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
import sys
import threading
import time
from datetime import date, timedelta

sys.path.insert(0, "/Users/damon/DamonProjects/believeboyDashboard/backend")

# 显式加载 backend/.env
from dotenv import load_dotenv

load_dotenv(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..",
        ".env",
    ),
    override=False,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("remote_low")

REMOTE_URL = os.environ.get("PROD_DATABASE_URL", "").strip()
if not REMOTE_URL:
    print(
        "错误: 未配置 PROD_DATABASE_URL。\n"
        "  请在 backend/.env 写入 PROD_DATABASE_URL=postgresql+psycopg://<user>:<pass>@<host>:<port>/<db>\n"
        "  或在启动前 export PROD_DATABASE_URL=...。\n"
        "  本脚本不再硬编码任何 IP——见 [BEL-75]。",
        file=sys.stderr,
    )
    sys.exit(1)


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


def run_queries(db):
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


def execute_agg(sid, engine, SessionLocal):
    start = time.time()
    try:
        db = SessionLocal()
        try:
            run_queries(db)
        finally:
            db.close()
        return {"sid": sid, "success": True, "elapsed": time.time() - start}
    except Exception as e:
        logger.error(f"[Agg-{sid}] FAILED: {e}")
        return {"sid": sid, "success": False, "error": str(e), "elapsed": time.time() - start}


def run_test(label, count, workers, engine, SessionLocal):
    logger.info("")
    logger.info("=" * 60)
    logger.info(f"🧪 {label}")
    logger.info(f"   并发: {count}, Worker: {workers}")
    logger.info("=" * 60)

    s = get_pool_status(engine)
    logger.info(f"[POOL BEFORE] in_use={s['checked_out']} size={s['size']}")

    start_time = time.time()
    results = []
    lock = threading.Lock()
    peak_conn = 0

    def wrapped(sid):
        nonlocal peak_conn
        r = execute_agg(sid, engine, SessionLocal)
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

    logger.info("-" * 60)
    logger.info(f"📊 {label}:")
    logger.info(f"   总耗时:     {total_time:.2f}s")
    logger.info(f"   成功/失败:  {success}/{failed}")
    logger.info(f"   平均:       {avg_time:.2f}s")
    logger.info(f"   P95:        {p95:.2f}s")
    logger.info(f"   吞吐量:     {len(results)/total_time:.2f}/s")
    logger.info(f"   峰值连接:   {peak_conn}")
    logger.info("=" * 60)

    return {
        "label": label, "count": count, "success": success, "failed": failed,
        "total_time": total_time, "avg_time": avg_time, "p95_time": p95,
        "throughput": len(results)/total_time if total_time > 0 else 0,
        "peak_conn": peak_conn,
    }


def main():
    logger.info("🚀 远程数据库低并发联通性验证（纯数据查询）")
    # Mask user:password@ in connection string for log safety
    masked_url = REMOTE_URL
    if "@" in masked_url:
        scheme, rest = masked_url.split("://", 1)
        masked_url = f"{scheme}://***:***@{rest.split('@', 1)[1]}"
    logger.info(f"   目标: {masked_url}")
    logger.info(f"   策略: connect_timeout=30, pool_size=20, max_overflow=20")
    logger.info("")

    engine, SessionLocal = _create_engine()
    logger.info("✅ 远程连接成功")

    results = []

    results.append(run_test("20 并发聚合查询", 20, 8, engine, SessionLocal))
    time.sleep(2)
    results.append(run_test("30 并发聚合查询", 30, 10, engine, SessionLocal))

    logger.info("")
    logger.info("📋 低并发测试结果")
    logger.info("-" * 80)
    logger.info(f"{'测试':<25} {'并发':>5} {'成功':>4} {'失败':>4} {'耗时':>8} {'平均':>7} {'P95':>7} {'峰值连接':>8}")
    logger.info("-" * 80)
    for r in results:
        logger.info(
            f"{r['label']:<25} {r['count']:>5} {r['success']:>4} {r['failed']:>4} "
            f"{r['total_time']:>7.1f}s {r['avg_time']:>6.2f}s {r['p95_time']:>6.2f}s {r['peak_conn']:>8}"
        )
    logger.info("-" * 80)

    engine.dispose()
    logger.info("✅ 低并发测试完成")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Schedule Report 高并发压力测试（100 / 1000 并发）
包含两个测试维度：
1. 聚合数据测试 — 模拟报表本地聚合查询中的 5 个复杂查询
2. 管线测试 — 模拟 _dispatch_one 完整生命周期（含 AI Semaphore 等待）
"""

from __future__ import annotations

import concurrent.futures
import logging
import sys
import threading
import time
from datetime import date, timedelta
from typing import Any

sys.path.insert(0, "/Users/damon/DamonProjects/believeboyDashboard/backend")

logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("stress_test")

# 模拟 AI Semaphore（真实代码中是 threading.Semaphore(2)）
AI_CONCURRENCY_LIMIT = 2
_ai_semaphore = threading.Semaphore(AI_CONCURRENCY_LIMIT)

# 模拟 AI 调用耗时（真实场景中 AI 摘要生成需要 5-30 秒）
AI_BUILD_DELAY = 3.0  # 秒，模拟报告构建中的 AI 调用


def get_pool_status(engine) -> dict:
    pool = engine.pool
    return {
        "pool_size": pool.size(),
        "checked_in": pool.checkedin(),
        "checked_out": pool.checkedout(),
        "overflow": getattr(pool, "_overflow", 0),
    }


def log_pool_status(engine, label: str = ""):
    s = get_pool_status(engine)
    logger.info(
        f"[POOL {label}] size={s['pool_size']} in_use={s['checked_out']} "
        f"available={s['pool_size'] + s['overflow'] - s['checked_out']} overflow={s['overflow']}"
    )


def _run_aggregate_queries(db) -> dict:
    """执行 5 个与真实报告构建一致的聚合查询"""
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

    # Q1: 销售总量聚合（最重的查询，全表扫描+聚合）
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

    # Q2: Top 5 SKU 分组聚合
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

    # Q3: 库存告警（大量 SKU 过滤）
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

    # Q4: 广告数据聚合
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

    # Q5: 退货原因分组聚合
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


def test_aggregate_only(subscription_id: int, engine) -> dict:
    """测试 1：纯聚合数据查询（session 用完即释放）"""
    from app.db.session import SessionLocal

    start = time.time()
    try:
        db = SessionLocal()
        try:
            results = _run_aggregate_queries(db)
        finally:
            db.close()

        elapsed = time.time() - start
        return {
            "subscription_id": subscription_id,
            "success": True,
            "elapsed": elapsed,
            "sales_qty": results["sales"]["qty"],
        }
    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"[Agg-{subscription_id}] FAILED: {e}")
        return {"subscription_id": subscription_id, "success": False, "error": str(e), "elapsed": elapsed}


def test_dispatch_pipeline(subscription_id: int, engine) -> dict:
    """测试 2：完整管线测试（模拟 _dispatch_one 生命周期）"""
    from app.db.session import SessionLocal

    start = time.time()
    semaphore_wait_time = 0.0
    ai_build_time = 0.0

    try:
        # 阶段 1: 创建 delivery log（获取 session，模拟插入）
        db1 = SessionLocal()
        try:
            time.sleep(0.01)  # 模拟 delivery_log 插入
        finally:
            db1.close()

        # 阶段 2: 获取 AI Semaphore（模拟 AI 限流等待）
        # 这是关键：真实代码中，semaphore 等待期间 session 不释放
        semaphore_start = time.time()
        _ai_semaphore.acquire()
        semaphore_wait_time = time.time() - semaphore_start

        try:
            # 阶段 3: 构建报告（创建新 session，执行聚合查询 + AI 模拟延迟）
            db2 = SessionLocal()
            try:
                results = _run_aggregate_queries(db2)
                # 模拟 AI 摘要生成耗时
                time.sleep(AI_BUILD_DELAY)
                ai_build_time = time.time() - semaphore_start
            finally:
                db2.close()
        finally:
            _ai_semaphore.release()

        # 阶段 4: 更新 delivery log（再次获取 session）
        db3 = SessionLocal()
        try:
            time.sleep(0.01)  # 模拟更新状态
        finally:
            db3.close()

        elapsed = time.time() - start
        return {
            "subscription_id": subscription_id,
            "success": True,
            "elapsed": elapsed,
            "semaphore_wait": semaphore_wait_time,
            "ai_build_time": ai_build_time,
            "sales_qty": results["sales"]["qty"],
        }
    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"[Pipe-{subscription_id}] FAILED: {e}")
        return {"subscription_id": subscription_id, "success": False, "error": str(e), "elapsed": elapsed}


def run_benchmark(name: str, test_func, num_subscriptions: int, max_workers: int, engine) -> dict:
    """运行一轮压力测试并返回统计"""
    logger.info("")
    logger.info("=" * 70)
    logger.info(f"🧪 {name}")
    logger.info(f"   订阅数: {num_subscriptions}, Worker: {max_workers}")
    logger.info("=" * 70)

    log_pool_status(engine, "BEFORE")

    start_time = time.time()
    results = []
    lock = threading.Lock()
    peak_connections = 0

    def wrapped_test(sid):
        nonlocal peak_connections
        r = test_func(sid, engine)
        s = get_pool_status(engine)
        with lock:
            peak_connections = max(peak_connections, s["checked_out"])
        return r

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(wrapped_test, i): i for i in range(num_subscriptions)}
        for future in concurrent.futures.as_completed(futures):
            try:
                results.append(future.result())
            except Exception as e:
                sid = futures[future]
                logger.error(f"[Task-{sid}] 异常: {e}")
                results.append({"subscription_id": sid, "success": False, "error": str(e)})

    total_time = time.time() - start_time
    log_pool_status(engine, "AFTER")

    # 统计
    success_count = sum(1 for r in results if r.get("success"))
    failed_count = len(results) - success_count
    elapsed_list = [r.get("elapsed", 0) for r in results]
    avg_time = sum(elapsed_list) / len(elapsed_list) if elapsed_list else 0
    max_time = max(elapsed_list) if elapsed_list else 0
    min_time = min(elapsed_list) if elapsed_list else 0
    p95 = sorted(elapsed_list)[int(len(elapsed_list) * 0.95)] if elapsed_list else 0

    semaphore_waits = [r.get("semaphore_wait", 0) for r in results if r.get("success")]
    avg_wait = sum(semaphore_waits) / len(semaphore_waits) if semaphore_waits else 0
    max_wait = max(semaphore_waits) if semaphore_waits else 0

    logger.info("-" * 70)
    logger.info(f"📊 {name} 统计:")
    logger.info(f"   总耗时:       {total_time:.2f}s")
    logger.info(f"   成功/失败:    {success_count}/{failed_count}")
    logger.info(f"   平均耗时:     {avg_time:.2f}s")
    logger.info(f"   最快/最慢:    {min_time:.2f}s / {max_time:.2f}s")
    logger.info(f"   P95 耗时:     {p95:.2f}s")
    logger.info(f"   吞吐量:       {len(results) / total_time:.2f} 订阅/秒")
    logger.info(f"   峰值连接:     {peak_connections}")
    if semaphore_waits:
        logger.info(f"   AI等待(avg):  {avg_wait:.2f}s")
        logger.info(f"   AI等待(max):  {max_wait:.2f}s")
    logger.info("=" * 70)

    return {
        "name": name,
        "total": num_subscriptions,
        "workers": max_workers,
        "success": success_count,
        "failed": failed_count,
        "total_time": total_time,
        "avg_time": avg_time,
        "min_time": min_time,
        "max_time": max_time,
        "p95_time": p95,
        "throughput": len(results) / total_time if total_time > 0 else 0,
        "peak_connections": peak_connections,
        "avg_semaphore_wait": avg_wait,
        "max_semaphore_wait": max_wait,
    }


def run_suite(num_subscriptions: int, max_workers: int, engine, label: str):
    """对指定并发数运行两个维度的测试"""
    logger.info("")
    logger.info("🔥" * 35)
    logger.info(f"  测试套件: {label} — {num_subscriptions} 订阅 × {max_workers} Worker")
    logger.info("🔥" * 35)

    results = []

    # 测试 1: 纯聚合查询
    results.append(run_benchmark(
        f"聚合数据测试 ({num_subscriptions} × {max_workers})",
        test_aggregate_only,
        num_subscriptions,
        max_workers,
        engine,
    ))

    time.sleep(2)

    # 测试 2: 完整管线
    results.append(run_benchmark(
        f"管线测试 ({num_subscriptions} × {max_workers})",
        test_dispatch_pipeline,
        num_subscriptions,
        max_workers,
        engine,
    ))

    return results


def main():
    from app.db.session import engine

    logger.info("🚀 Schedule Report 高并发压力测试")
    logger.info(f"   目标数据库: localhost:5432/BLF")
    logger.info(f"   SQLAlchemy Pool: pool_size=20, max_overflow=20 (max=40)")
    logger.info(f"   AI Semaphore: {AI_CONCURRENCY_LIMIT}, AI 模拟延迟: {AI_BUILD_DELAY}s")
    logger.info("")

    all_results = []

    # 场景 1: 100 并发（日常峰值预期）
    all_results.extend(run_suite(100, 16, engine, "本地 100 并发"))
    time.sleep(3)

    # 场景 2: 1000 并发（极限压力测试）
    all_results.extend(run_suite(1000, 32, engine, "本地 1000 并发"))

    # 最终汇总
    logger.info("")
    logger.info("📋 全部测试结果汇总")
    logger.info("-" * 100)
    logger.info(
        f"{'测试名称':<35} {'总':>5} {'成':>4} {'败':>4} {'总耗时':>8} {'平均':>7} "
        f"{'P95':>7} {'峰值连接':>8} {'吞吐':>8}"
    )
    logger.info("-" * 100)
    for r in all_results:
        logger.info(
            f"{r['name']:<35} "
            f"{r['total']:>5} "
            f"{r['success']:>4} "
            f"{r['failed']:>4} "
            f"{r['total_time']:>7.1f}s "
            f"{r['avg_time']:>6.2f}s "
            f"{r['p95_time']:>6.2f}s "
            f"{r['peak_connections']:>8} "
            f"{r['throughput']:>7.2f}/s"
        )
    logger.info("-" * 100)

    # 判断
    logger.info("")
    logger.info("💡 判断:")
    failed_any = any(r["failed"] > 0 for r in all_results)
    peak_conn = max(r["peak_connections"] for r in all_results)
    if failed_any:
        logger.info("   ❌ 测试中出现失败，需要调优")
    else:
        logger.info("   ✅ 所有测试均成功完成")
    logger.info(f"   峰值连接使用: {peak_conn}/40")
    if peak_conn >= 35:
        logger.info("   ⚠️  接近连接池上限，建议增大 max_overflow")
    elif peak_conn >= 20:
        logger.info("   ⚠️  连接池使用过半，当前配置安全")
    else:
        logger.info("   ✅ 连接池余量充足")


if __name__ == "__main__":
    main()

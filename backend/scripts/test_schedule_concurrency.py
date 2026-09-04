#!/usr/bin/env python3
"""
Schedule Report 并发压力测试
模拟 10-20 个订阅同时触发时数据库的真实表现
"""

from __future__ import annotations

import concurrent.futures
import logging
import sys
import time
from contextlib import contextmanager
from datetime import date, timedelta

sys.path.insert(0, "/Users/damon/DamonProjects/believeboyDashboard/backend")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("stress_test")


def get_pool_status(engine) -> dict:
    """获取连接池当前状态"""
    pool = engine.pool
    return {
        "pool_size": pool.size(),
        "checked_in": pool.checkedin(),
        "checked_out": pool.checkedout(),
        "overflow": getattr(pool, "_overflow", 0),
        "total_in_use": pool.checkedout(),
        "total_available": pool.size() + getattr(pool, "_overflow", 0) - pool.checkedout(),
    }


def log_pool_status(engine, label: str = ""):
    """打印连接池状态"""
    status = get_pool_status(engine)
    logger.info(
        f"[POOL {label}] size={status['pool_size']} "
        f"in_use={status['checked_out']} "
        f"available={status['total_available']} "
        f"overflow={status['overflow']}"
    )


def simulate_report_building(db, project_ids: list[int] | None, country: str) -> dict:
    """模拟报告构建中的真实查询负载"""
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
    results = {}

    # 查询1: 销售概览（聚合）——最重的查询
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
    if project_ids:
        q1 = q1.filter(AnalysisSourceFile.project_id.in_(project_ids))
    row = q1.first()
    results["sales"] = {"qty": int(row.qty) if row else 0, "amount": float(row.amount) if row else 0}

    # 查询2: Top 5 SKU
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

    # 查询3: 库存告警
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

    # 查询4: 广告数据
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
    if project_ids:
        q4 = q4.filter(AnalysisSourceFile.project_id.in_(project_ids))
    row = q4.first()
    results["ads"] = {
        "spend": float(row.spend) if row else 0,
        "sales": float(row.sales) if row else 0,
    }

    # 查询5: 退货原因
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


def dispatch_single(subscription_id: int, engine) -> dict:
    """模拟单个订阅的 dispatch 流程"""
    from app.db.session import SessionLocal

    start = time.time()
    thread_name = f"Sub-{subscription_id}"

    try:
        # 阶段1: 创建 delivery log（使用 session）
        db1 = SessionLocal()
        try:
            # 模拟 delivery_log 插入
            time.sleep(0.05)
        finally:
            db1.close()

        # 阶段2: 构建报告（创建新 session，执行多个复杂查询）
        db2 = SessionLocal()
        try:
            # 模拟真实报告构建查询
            # 使用 project_id=None (全部项目) 或随机项目
            project_ids = None
            country = "US"
            report_data = simulate_report_building(db2, project_ids, country)
        finally:
            db2.close()

        # 阶段3: 更新 delivery log（再次获取 session）
        db3 = SessionLocal()
        try:
            time.sleep(0.05)
        finally:
            db3.close()

        elapsed = time.time() - start
        logger.info(f"[{thread_name}] SUCCESS in {elapsed:.2f}s "
                    f"(sales_qty={report_data['sales']['qty']}, "
                    f"skus={len(report_data['top_skus'])}, "
                    f"inv={len(report_data['inventory'])}, "
                    f"ads_spend={report_data['ads']['spend']:.2f})")
        return {"subscription_id": subscription_id, "success": True, "elapsed": elapsed}

    except Exception as e:
        elapsed = time.time() - start
        logger.error(f"[{thread_name}] FAILED in {elapsed:.2f}s: {e}")
        return {"subscription_id": subscription_id, "success": False, "error": str(e), "elapsed": elapsed}


def run_test(num_subscriptions: int, max_workers: int, label: str):
    """运行一轮压力测试"""
    from app.db.session import engine

    logger.info("=" * 70)
    logger.info(f"🧪 压力测试: {label}")
    logger.info(f"   订阅数: {num_subscriptions}, 并发 Worker: {max_workers}")
    logger.info("=" * 70)

    log_pool_status(engine, "BEFORE")

    start_time = time.time()
    results = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(dispatch_single, i, engine): i
            for i in range(num_subscriptions)
        }

        for future in concurrent.futures.as_completed(futures):
            sub_id = futures[future]
            try:
                result = future.result()
                results.append(result)
                if sub_id % 5 == 0:
                    log_pool_status(engine, f"mid@{sub_id}")
            except Exception as e:
                logger.error(f"[Sub-{sub_id}] 异常: {e}")
                results.append({"subscription_id": sub_id, "success": False, "error": str(e)})

    total_time = time.time() - start_time
    log_pool_status(engine, "AFTER")

    # 统计
    success_count = sum(1 for r in results if r.get("success"))
    failed_count = len(results) - success_count
    avg_time = sum(r.get("elapsed", 0) for r in results) / len(results) if results else 0
    max_time = max((r.get("elapsed", 0) for r in results), default=0)

    logger.info("-" * 70)
    logger.info(f"📊 结果统计:")
    logger.info(f"   总耗时:     {total_time:.2f}s")
    logger.info(f"   成功:       {success_count}/{len(results)}")
    logger.info(f"   失败:       {failed_count}")
    logger.info(f"   平均耗时:   {avg_time:.2f}s/订阅")
    logger.info(f"   最慢耗时:   {max_time:.2f}s")
    logger.info(f"   吞吐量:     {len(results)/total_time:.2f} 订阅/秒")
    logger.info("=" * 70)

    return {
        "label": label,
        "num_subscriptions": num_subscriptions,
        "max_workers": max_workers,
        "total_time": total_time,
        "success": success_count,
        "failed": failed_count,
        "avg_time": avg_time,
        "max_time": max_time,
        "throughput": len(results) / total_time if total_time > 0 else 0,
    }


def main():
    from app.db.session import engine

    logger.info("🚀 Schedule Report 并发压力测试开始")
    logger.info(f"   目标数据库: localhost:5432/BLF")
    logger.info(f"   SQLAlchemy Pool: pool_size=5, max_overflow=10")
    logger.info(f"   PG max_connections: 100")
    logger.info("")

    all_results = []

    # 测试场景1: 10 个订阅，8 个 worker（模拟日常场景）
    all_results.append(run_test(10, 8, "10订阅 × 8Worker"))
    time.sleep(2)

    # 测试场景2: 16 个订阅，8 个 worker（用户预期场景）
    all_results.append(run_test(16, 8, "16订阅 × 8Worker"))
    time.sleep(2)

    # 测试场景3: 20 个订阅，8 个 worker（极限场景）
    all_results.append(run_test(20, 8, "20订阅 × 8Worker"))
    time.sleep(2)

    # 测试场景4: 20 个订阅，4 个 worker（降低并发对比）
    all_results.append(run_test(20, 4, "20订阅 × 4Worker"))

    # 最终汇总
    logger.info("")
    logger.info("📋 全部测试结果汇总")
    logger.info("-" * 70)
    logger.info(f"{'场景':<20} {'总耗时':>8} {'成功':>6} {'失败':>6} {'平均':>8} {'吞吐':>8}")
    logger.info("-" * 70)
    for r in all_results:
        logger.info(
            f"{r['label']:<20} "
            f"{r['total_time']:>7.1f}s "
            f"{r['success']:>5}/{r['num_subscriptions']} "
            f"{r['failed']:>5} "
            f"{r['avg_time']:>7.2f}s "
            f"{r['throughput']:>7.2f}/s"
        )
    logger.info("-" * 70)

    # 给出建议
    logger.info("")
    logger.info("💡 基于测试结果的建议:")
    failed_any = any(r["failed"] > 0 for r in all_results)
    if failed_any:
        logger.info("   ⚠️  测试中出现失败，需要检查连接池超时或查询性能")
    else:
        logger.info("   ✅ 所有测试均成功完成")

    # 计算推荐的连接池配置
    max_concurrent = max(r["num_subscriptions"] for r in all_results)
    recommended_pool = max(15, int(max_concurrent * 1.5))
    logger.info(f"   当前 pool_size=5, max_overflow=10 (max=15)")
    logger.info(f"   建议调整为 pool_size={recommended_pool}, max_overflow=15 (max={recommended_pool + 15})")


if __name__ == "__main__":
    main()

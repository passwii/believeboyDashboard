"""
数据库监控专家 - 数字员工 #2
定期检查数据库表健康状态，主动上报到 digital_employee 表。
可以独立运行（python run_db_monitor.py）或被其他调度器调用。

Usage:
    python scripts/run_db_monitor.py
    # 或配合 cron：每5分钟运行一次
    # */5 * * * * cd /path/to/backend && .venv/bin/python scripts/run_db_monitor.py
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import datetime, UTC, timedelta
from app.db.session import SessionLocal
from app.models.digital_employee import DigitalEmployee, EmployeeStatus
from app.services.digital_employee_reporter import (
    report_heartbeat,
    start_task,
    complete_task,
    get_or_create_employee,
)

EMPLOYEE_ID = int(os.environ.get("DB_MONITOR_EMPLOYEE_ID", "2"))
STALE_THRESHOLD_HOURS = int(os.environ.get("STALE_THRESHOLD_HOURS", "72"))


def check_db_health(db) -> dict:
    """检查数据库健康状态，返回汇总信息"""
    from sqlalchemy import text

    result = {
        "healthy": 0,
        "stale": 0,
        "empty": 0,
        "error": 0,
        "total": 0,
        "stale_tables": [],
    }

    # 获取所有业务表（排除 alembic 系统表）
    try:
        rows = db.execute(text("""
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename NOT LIKE 'alembic%'
              AND tablename NOT LIKE '_prisma_%'
            ORDER BY tablename
        """)).fetchall()
        tables = [r[0] for r in rows]
    except Exception:
        tables = []

    result["total"] = len(tables)
    threshold = datetime.now(UTC) - timedelta(hours=STALE_THRESHOLD_HOURS)

    for table in tables:
        try:
            count_row = db.execute(text(f'SELECT COUNT(*) FROM "{table}"')).fetchone()
            row_count = count_row[0] if count_row else 0

            if row_count == 0:
                result["empty"] += 1
                continue

            # 检查最后更新时间
            cols_to_check = ["updated_at", "created_at", "last_seen_at"]
            last_updated = None
            for col in cols_to_check:
                try:
                    r = db.execute(text(f'SELECT MAX("{col}") FROM "{table}"')).fetchone()
                    if r and r[0]:
                        last_updated = r[0]
                        break
                except Exception:
                    continue

            if last_updated:
                if isinstance(last_updated, str):
                    last_updated = datetime.fromisoformat(last_updated.replace("Z", "+00:00"))
                if last_updated < threshold:
                    result["stale"] += 1
                    result["stale_tables"].append({"table": table, "last_updated": str(last_updated)})
                else:
                    result["healthy"] += 1
            else:
                result["healthy"] += 1

        except Exception as e:
            result["error"] += 1

    return result


def run_monitor_cycle():
    """执行一次监控周期"""
    db = SessionLocal()
    task_id = f"db-monitor-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}"

    try:
        # 创建任务记录
        start_task(db, EMPLOYEE_ID, task_id, "数据库健康检查", "db_check")
        report_heartbeat(db, EMPLOYEE_ID, task_id, "running", 10, "连接数据库")

        health = check_db_health(db)
        db.rollback()  # clean slate before next operations
        report_heartbeat(db, EMPLOYEE_ID, task_id, "running", 60, f"检查了 {health['total']} 张表")

        # 更新员工状态
        employee = db.get(DigitalEmployee, EMPLOYEE_ID)
        if employee:
            if health["error"] > 0:
                employee.status = EmployeeStatus.FAILED
            elif health["stale"] > 5:
                employee.status = EmployeeStatus.FAILED
            elif health["stale"] > 0:
                employee.status = EmployeeStatus.SUCCEEDED  # 有警告但正常运行
            else:
                employee.status = EmployeeStatus.SUCCEEDED
            db.commit()

        # 生成摘要消息
        summary = (
            f"数据库监控完成：共{health['total']}张表，"
            f"健康{health['healthy']}，陈旧{health['stale']}，空表{health['empty']}，错误{health['error']}"
        )
        complete_task(db, task_id, success=(health["error"] == 0), error_message=None if health["error"] == 0 else f"{health['error']} 张表查询失败")

        return health

    except Exception as exc:
        db.rollback()
        try:
            report_heartbeat(db, EMPLOYEE_ID, task_id, "FAILED", 0, f"监控异常: {exc}")
            complete_task(db, task_id, success=False, error=str(exc))
        except Exception:
            pass
        raise
    finally:
        db.close()


def main():
    interval_secs = int(os.environ.get("DB_MONITOR_INTERVAL", "300"))  # 默认5分钟

    print(f"[数据库监控专家] 启动，监控间隔 {interval_secs}s，Employee ID={EMPLOYEE_ID}")
    print(f"[数据库监控专家] 陈旧阈值 {STALE_THRESHOLD_HOURS}h")

    while True:
        try:
            health = run_monitor_cycle()
            print(f"[数据库监控专家] 完成: {health['total']}张表, 健康{health['healthy']}, 陈旧{health['stale']}")
        except Exception as exc:
            print(f"[数据库监控专家] 错误: {exc}")

        time.sleep(interval_secs)


if __name__ == "__main__":
    if "--once" in sys.argv:
        run_monitor_cycle()
    else:
        main()
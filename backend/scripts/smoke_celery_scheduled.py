"""本地 Celery 冒烟测试（定时报告 scheduled 队列）。

前提（终端分开跑）：
  1) redis-server --daemonize yes
  2) celery -A app.tasks.celery_app worker -Q scheduled -c 1 --loglevel=info

本脚本只验证「Celery 管线跑通」：
  - dispatch_one 是否路由到 scheduled 队列
  - worker 是否真的从 scheduled 队列取走并执行该任务
任务体因本地没有完整栈（Postgres/Playwright/SMTP/真实广告数据）
会在 DB 查询处失败，但只要状态离开 PENDING，就证明 worker 已消费。
"""

from __future__ import annotations

import sys
import time
from datetime import date


def test_routing() -> None:
    from app.tasks.celery_app import celery_app

    routes = celery_app.conf.task_routes
    assert routes.get("dispatch_one") == {"queue": "scheduled"}, routes
    print("[1] 路由检查 ✔  dispatch_one -> scheduled 队列")


def test_dispatch_pickup() -> None:
    from app.celery_tasks.scheduled_report import dispatch_one

    ar = dispatch_one.delay(
        subscription_id=999999,  # 故意不存在，避免真发邮件
        email="smoke@example.com",
        project_ids=None,
        country="US",
        frequency="daily",
        report_date=date.today().isoformat(),
        triggered_by="manual",
    )
    print(f"[2] 已入队 task_id={ar.id}，轮询 scheduled worker ...")

    state = "PENDING"
    for _ in range(40):  # 最多 ~20s
        state = ar.state
        if state != "PENDING":
            break
        time.sleep(0.5)

    if state == "PENDING":
        print("[2] ✗ 任务一直 PENDING —— worker 没消费 scheduled 队列")
        print("     检查: celery worker 是否带 -Q scheduled 启动？redis 是否可达？")
        sys.exit(1)

    print(f"[2] 任务被 worker 取走并执行 ✔  最终状态={state}")
    print("     (FAILURE 仅因本地缺 DB/广告数据，证明 worker 已跑任务体)")


if __name__ == "__main__":
    test_routing()
    test_dispatch_pickup()
    print("\n✅ Celery scheduled 管线在本地跑通：broker 可达 + worker 消费 scheduled 队列")

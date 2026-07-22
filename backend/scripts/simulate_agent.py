"""数字员工虚拟办公室端到端模拟器。

注册多个不同类型的员工，上报带真实 metadata 的任务流（含中间进度、
FAILED、并发排队），用于验证伸展引擎 + SSE + 前端工牌墙。

用法：
  python scripts/simulate_agent.py --base http://localhost:8000
  python scripts/simulate_agent.py --base http://localhost:8000 --speed 2  # 2x 加速

场景：
  1. 报表快递员（auto_report_upload）：3 个报表任务，含中间进度，1 个 FAILED
  2. 定时指挥官（scheduled_job）：2 个定时任务，快速完成
  3. 洞察分析师（ai_agent）：1 个长任务 + 2 个并发短任务（触发排队/忙碌）
"""
import argparse
import random
import time
import uuid

import requests

# ── 模拟数据 ──────────────────────────────────────────────────────────────────

PROJECTS = [
    {"project_name": "润茗", "report_label": "Payment Report"},
    {"project_name": "弥森", "report_label": "Business Report"},
    {"project_name": "星河", "report_label": "Inventory Analysis"},
    {"project_name": "云帆", "report_label": "SKU Export"},
    {"project_name": "润茗", "report_label": "Advertising Summary"},
]

STEPS = [
    "正在连接数据源…",
    "数据识别完成，开始抽取…",
    "正在核对报表数据…",
    "生成图表与汇总…",
    "正在上传至 S3…",
    "校验完整性…",
]

EMPLOYEES = [
    {"name": "报表快递员·小王", "employee_type": "auto_report_upload", "description": "负责每日报表生成与分发"},
    {"name": "定时指挥官·小李", "employee_type": "scheduled_job", "description": "管理定时任务调度"},
    {"name": "洞察分析师·小张", "employee_type": "ai_agent", "description": "AI 驱动的数据洞察"},
]


def _heartbeat(api: str, emp_id: int, secret: str, payload: dict):
    r = requests.post(f"{api}/{emp_id}/heartbeat", params={"api_secret": secret}, json=payload)
    r.raise_for_status()


def _register(api: str, emp: dict) -> tuple[int, str]:
    r = requests.post(f"{api}/register", json={
        **emp, "is_silent_alert_threshold_minutes": 30,
    })
    r.raise_for_status()
    data = r.json()
    return data["id"], data["api_secret"]


def run_task(api, emp_id, secret, project, task_type, speed, fail=False):
    """模拟一个任务的完整生命周期：RUNNING → 中间进度 → SUCCEEDED/FAILED。"""
    task_id = f"sim-{uuid.uuid4().hex[:8]}"
    meta = {**project, "row_count": random.randint(200, 5000)}
    task_name = f"{project['project_name']}/{project['report_label']}"

    # 开始
    _heartbeat(api, emp_id, secret, {
        "task_id": task_id,
        "task_name": task_name,
        "task_type": task_type,
        "status": "RUNNING",
        "progress_percent": 5,
        "current_step": STEPS[0],
        "message": f"开始处理 {task_name}",
        "metadata_json": meta,
    })
    time.sleep(1.5 / speed)

    # 中间进度（3~5 步）
    n_steps = random.randint(3, 5)
    for i in range(1, n_steps + 1):
        pct = min(10 + int(80 * i / (n_steps + 1)), 90)
        step = STEPS[min(i, len(STEPS) - 1)]
        _heartbeat(api, emp_id, secret, {
            "task_id": task_id,
            "status": "RUNNING",
            "progress_percent": pct,
            "current_step": step,
            "metadata_json": meta,
        })
        time.sleep(random.uniform(1.0, 2.5) / speed)

    # 结束
    if fail:
        _heartbeat(api, emp_id, secret, {
            "task_id": task_id,
            "status": "FAILED",
            "progress_percent": pct,
            "current_step": "❌ 数据源连接超时",
            "message": f"{task_name} 处理失败：数据源连接超时",
            "metadata_json": meta,
        })
    else:
        _heartbeat(api, emp_id, secret, {
            "task_id": task_id,
            "status": "SUCCEEDED",
            "progress_percent": 100,
            "current_step": "完成",
            "message": f"{task_name} 处理完成",
            "metadata_json": meta,
        })
    return task_id


def main():
    p = argparse.ArgumentParser(description="数字员工虚拟办公室模拟器")
    p.add_argument("--base", default="http://localhost:8000", help="后端地址")
    p.add_argument("--speed", type=float, default=1.0, help="加速倍率（2 = 2x）")
    args = p.parse_args()
    api = f"{args.base}/api/v1/digital-employees"
    speed = args.speed

    # 注册员工
    registered = []
    for emp in EMPLOYEES:
        emp_id, secret = _register(api, emp)
        registered.append((emp_id, secret, emp))
        print(f"✅ 注册 {emp['name']} → employee_id={emp_id}")

    print(f"\n🚀 开始模拟（{speed}x 速度）…\n")

    # ── 场景 1：报表快递员 — 3 个任务，第 2 个失败 ──
    emp_id, secret, emp = registered[0]
    print(f"📤 {emp['name']}：上报 3 个报表任务（含 1 个 FAILED）")
    for i, proj in enumerate(PROJECTS[:3]):
        fail = (i == 1)
        tid = run_task(api, emp_id, secret, proj, "payment_report", speed, fail=fail)
        status = "FAILED ❌" if fail else "SUCCEEDED ✅"
        print(f"   task {tid} → {status}")

    # ── 场景 2：定时指挥官 — 2 个快速任务 ──
    emp_id, secret, emp = registered[1]
    print(f"\n⏰ {emp['name']}：上报 2 个快速定时任务")
    for proj in PROJECTS[3:5]:
        tid = run_task(api, emp_id, secret, proj, "scheduled_export", speed)
        print(f"   task {tid} → SUCCEEDED ✅")

    # ── 场景 3：洞察分析师 — 1 个长任务 + 2 个并发短任务（触发排队） ──
    emp_id, secret, emp = registered[2]
    print(f"\n💬 {emp['name']}：上报 1 个长任务 + 2 个并发短任务（触发排队/忙碌）")

    # 长任务开始
    long_task_id = f"sim-{uuid.uuid4().hex[:8]}"
    long_proj = PROJECTS[2]
    long_meta = {**long_proj, "row_count": 8000}
    _heartbeat(api, emp_id, secret, {
        "task_id": long_task_id,
        "task_name": f"{long_proj['project_name']}/{long_proj['report_label']}",
        "task_type": "ai_insight",
        "status": "RUNNING",
        "progress_percent": 10,
        "current_step": "正在分析数据趋势…",
        "message": f"开始深度分析 {long_proj['project_name']}",
        "metadata_json": long_meta,
    })
    time.sleep(1.0 / speed)

    # 并发短任务（排队）
    for proj in PROJECTS[:2]:
        tid = run_task(api, emp_id, secret, proj, "quick_insight", speed)
        print(f"   并发 task {tid} → SUCCEEDED ✅")

    # 长任务继续推进
    for pct in [30, 55, 75, 90]:
        _heartbeat(api, emp_id, secret, {
            "task_id": long_task_id,
            "status": "RUNNING",
            "progress_percent": pct,
            "current_step": f"深度分析中… {pct}%",
            "metadata_json": long_meta,
        })
        time.sleep(1.5 / speed)

    _heartbeat(api, emp_id, secret, {
        "task_id": long_task_id,
        "status": "SUCCEEDED",
        "progress_percent": 100,
        "current_step": "洞察报告已生成",
        "message": f"{long_proj['project_name']} 深度分析完成",
        "metadata_json": long_meta,
    })
    print(f"   长任务 {long_task_id} → SUCCEEDED ✅")

    print(f"\n🎉 模拟完成！打开 {args.base.replace('8000', '3200')}/dashboard/ai/digital-employees/office 观察工牌墙")
    print("   伸展引擎会把几秒的真实任务拉伸成 30min~2h 的慢播。")


if __name__ == "__main__":
    main()

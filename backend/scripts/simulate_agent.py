"""通过心跳 API 喂一个假 Agent，用于本地端到端验证伸展引擎。

用法：
  python scripts/simulate_agent.py --base http://localhost:8000 --count 3
会注册一个员工并上报 count 个短任务（每个真实约 5 秒完成）。
"""
import argparse
import time
import uuid

import requests


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://localhost:8000")
    p.add_argument("--count", type=int, default=3)
    args = p.parse_args()
    api = f"{args.base}/api/v1/digital-employees"

    r = requests.post(f"{api}/register", json={
        "name": "模拟快递员", "employee_type": "auto_report_upload",
        "description": "端到端验证用", "is_silent_alert_threshold_minutes": 30,
    })
    r.raise_for_status()
    emp_id, secret = r.json()["id"], r.json()["api_secret"]
    print(f"registered employee_id={emp_id}")

    for i in range(args.count):
        task_id = f"sim-{uuid.uuid4().hex[:8]}"
        requests.post(f"{api}/{emp_id}/heartbeat", params={"api_secret": secret}, json={
            "task_id": task_id, "status": "RUNNING", "progress_percent": 10,
            "current_step": "数据识别完成", "message": f"开始处理 sim-{i}",
        })
        time.sleep(5)
        requests.post(f"{api}/{emp_id}/heartbeat", params={"api_secret": secret}, json={
            "task_id": task_id, "status": "SUCCEEDED", "progress_percent": 100,
            "current_step": "完成", "message": f"完成 sim-{i}",
        })
        print(f"task {i} reported")
    print("done — 打开前端 /office 观察是否被拉伸成慢播")


if __name__ == "__main__":
    main()

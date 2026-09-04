#!/usr/bin/env python3
"""
Agent Testing — 自动化回归测试 CLI，集成数字员工状态上报。

Usage:
    cd backend
    source .venv/bin/activate

    # 方式 1：同步到 Dashboard（需要先配置环境变量）
    export DIGITAL_EMPLOYEE_API_BASE_URL=http://localhost:3200
    export DIGITAL_EMPLOYEE_ID=6
    export DIGITAL_EMPLOYEE_API_SECRET=your-secret
    python scripts/agent_testing_cli.py

    # 方式 2：仅本地运行，不上报
    python scripts/agent_testing_cli.py --dry-run

    # 方式 3：只跑特定模块
    python scripts/agent_testing_cli.py --module ui_permissions
    python scripts/agent_testing_cli.py --module pricing
    python scripts/agent_testing_cli.py --module report_upload
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import textwrap
import traceback
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.digital_employee_client import DigitalEmployeeClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("agent_testing")

BACKEND_ROOT = Path(__file__).resolve().parents[1]
AGENT_TESTING_DIR = BACKEND_ROOT / "scripts" / "agent_testing"

# 模块定义
MODULES = {
    "permissions_api": {
        "label": "权限 API 测试",
        "path": AGENT_TESTING_DIR / "test_permissions_api.py",
        "pytest_args": ["-v", "--tb=short"],
    },
    "ui_permissions": {
        "label": "UI 权限测试",
        "path": AGENT_TESTING_DIR / "test_ui_permissions.py",
        "pytest_args": ["-v", "--tb=short"],
    },
    "ui_stability": {
        "label": "UI 稳定性测试",
        "path": AGENT_TESTING_DIR / "test_ui_stability.py",
        "pytest_args": ["-v", "--tb=short"],
    },
    "pricing": {
        "label": "定价计算回归",
        "path": BACKEND_ROOT / "tests" / "test_pricing_calculation_service.py",
        "pytest_args": ["-v", "--tb=short"],
    },
    "report_upload": {
        "label": "报表上传测试",
        "path": BACKEND_ROOT / "tests" / "test_report_upload_service.py",
        "pytest_args": ["-v", "--tb=short"],
    },
}


# ── Pytest Runner ──────────────────────────────────────────────────────────────

@dataclass
class PytestResult:
    module: str
    label: str
    passed: int
    failed: int
    skipped: int
    errors: int
    stdout: str
    returncode: int


def run_pytest(test_path: Path, pytest_args: list[str], cwd: Path) -> PytestResult:
    """运行单个 pytest 模块，返回结果。"""
    cmd = ["pytest", str(test_path)] + pytest_args
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    stdout = result.stdout + result.stderr

    # 解析 pytest 输出（使用正则提取数字，处理 "= 11 failed =" 格式）
    passed = failed = skipped = errors = 0
    summary_pattern = re.compile(r"(\d+)\s+(passed|failed|skipped|error)")

    for line in stdout.splitlines():
        line = line.strip()
        # 匹配 "N passed/failed/skipped/error" 格式（数字可能在 = 符号之间）
        match = summary_pattern.search(line)
        if match:
            n = int(match.group(1))
            stat = match.group(2)
            if stat == "passed":
                passed = n
            elif stat == "failed":
                failed = n
            elif stat == "skipped":
                skipped = n
            elif stat == "error":
                errors = n

    return PytestResult(
        module=test_path.stem,
        label="",
        passed=passed,
        failed=failed,
        skipped=skipped,
        errors=errors,
        stdout=stdout,
        returncode=result.returncode,
    )


# ── Main ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agent Testing — 自动化回归测试")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅本地运行，不连接生产端 Dashboard",
    )
    parser.add_argument(
        "--module",
        choices=list(MODULES.keys()),
        help="只运行指定模块（默认运行全部）",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Playwright 使用有头模式（可见浏览器）",
    )
    parser.add_argument(
        "--slowmo",
        type=int,
        default=0,
        help="Playwright 慢动作延迟（毫秒）",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    modules_to_run = [args.module] if args.module else list(MODULES.keys())

    # 上报客户端
    client: DigitalEmployeeClient | _NoopClient
    if args.dry_run:
        client = _NoopClient()
        log.info("[DRY RUN] 跳过生产端连接")
    else:
        try:
            client = DigitalEmployeeClient.from_env()
            log.info("已连接 Dashboard，employee_id=%s", client.employee_id)
        except EnvironmentError as exc:
            log.error("配置错误: %s", exc)
            log.info("使用 --dry-run 跳过连接，或设置以下环境变量：")
            log.info("  DIGITAL_EMPLOYEE_API_BASE_URL, DIGITAL_EMPLOYEE_ID, DIGITAL_EMPLOYEE_API_SECRET")
            sys.exit(1)

    task_name = "自动化回归测试"
    task_id = client.start_task(task_name, task_type="AGENT_TESTING")
    log.info("任务已启动: %s", task_id)
    client.log(task_id, "INFO", f"开始回归测试，共 {len(modules_to_run)} 个模块")

    results: list[dict] = []
    all_passed = True

    for i, mod_key in enumerate(modules_to_run):
        mod = MODULES[mod_key]
        progress = int((i / len(modules_to_run)) * 100)
        step = f"运行中: {mod['label']}"
        client.update_progress(task_id, "RUNNING", progress, step)
        client.log(task_id, "INFO", f"▶ {mod['label']}")

        # 构建 pytest 参数
        pytest_args = list(mod["pytest_args"])
        if args.headed:
            pytest_args.append("--headed")
        if args.slowmo > 0:
            pytest_args.extend(["--slowmo", str(args.slowmo)])

        result = run_pytest(mod["path"], pytest_args, BACKEND_ROOT)

        status_icon = "✅" if result.returncode == 0 else "❌"
        log_line = f"{status_icon} {mod['label']}: {result.passed} passed, {result.failed} failed, {result.skipped} skipped"
        log.info(log_line)
        client.log(task_id, "INFO" if result.returncode == 0 else "ERROR", log_line)

        if result.returncode != 0:
            all_passed = False
            # 截取关键错误信息
            lines = result.stdout.splitlines()
            error_lines = [l for l in lines if "FAILED" in l or "ERROR" in l or "AssertionError" in l]
            if error_lines:
                error_summary = "\n".join(error_lines[:5])
                client.log(task_id, "WARN", f"错误摘要:\n{error_summary}")

        results.append({
            "module": mod_key,
            "label": mod["label"],
            "passed": result.passed,
            "failed": result.failed,
            "skipped": result.skipped,
            "errors": result.errors,
            "returncode": result.returncode,
        })

    # 最终进度
    client.update_progress(task_id, "RUNNING", 95, "汇总结果")

    # 打印汇总
    print_summary(results)

    if all_passed:
        client.update_progress(task_id, "SUCCEEDED", 100, "全部通过")
        client.log(task_id, "INFO", "🎉 所有模块测试通过")
        client.complete(task_id, metadata={"results": results, "all_passed": True})
        log.info("✅ 全部测试通过")
    else:
        failed_modules = [r["label"] for r in results if r["returncode"] != 0]
        client.update_progress(task_id, "FAILED", 100, f"失败: {', '.join(failed_modules)}")
        client.log(task_id, "ERROR", f"❌ 失败模块: {', '.join(failed_modules)}")
        client.fail(task_id, f"失败模块: {', '.join(failed_modules)}")
        log.error("❌ 有测试失败")
        sys.exit(1)


def print_summary(results: list[dict]) -> None:
    print()
    print("=" * 60)
    print("  Agent Testing Summary")
    print("=" * 60)
    total_passed = total_failed = total_skipped = 0
    for r in results:
        icon = "✅" if r["returncode"] == 0 else "❌"
        print(f"  {icon} {r['label']}")
        print(f"      passed={r['passed']} failed={r['failed']} skipped={r['skipped']}")
        total_passed += r["passed"]
        total_failed += r["failed"]
        total_skipped += r["skipped"]
    print("-" * 60)
    print(f"  总计: passed={total_passed} failed={total_failed} skipped={total_skipped}")
    print("=" * 60)


# ── Noop client ────────────────────────────────────────────────────────────────

class _NoopClient:
    _task_id: str = "dry-run"
    def start_task(self, task_name: str, task_type: str = "") -> str:
        log.info("[DRY RUN] start_task: %s", task_name)
        return "dry-run"
    def update_progress(self, task_id: str, status: str, progress: int, step: str) -> None:
        log.info("[DRY RUN] progress: %s%% %s", progress, step)
    def log(self, task_id: str, level: str, message: str) -> None:
        log.info("[DRY RUN] log [%s]: %s", level, message[:80])
    def complete(self, task_id: str, metadata: dict[str, Any] | None = None) -> None:
        log.info("[DRY RUN] complete with metadata=%s", metadata)
    def fail(self, task_id: str, error: str) -> None:
        log.info("[DRY RUN] fail: %s", error)


if __name__ == "__main__":
    main()
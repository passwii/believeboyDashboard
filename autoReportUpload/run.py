#!/usr/bin/env python3
"""
autoReportUpload — entry point.

Usage:
    python run.py                  # Normal mode (启动时全盘扫描，watchdog 持续监控新文件)
    python run.py --dry-run        # Dry-run: recognize files only, no DB writes, no file moves
    python run.py --once           # Run once (no periodic loop), useful for testing
    python run.py --mode polling   # 旧版定时轮询模式（每 5 分钟）

Requires env (or autoReportUpload/.env):
    API_BASE_URL=https://dash-api.believeboy.com
    INTERNAL_INGEST_TOKEN=<32 字节随机串>
"""

import argparse
import sys
from pathlib import Path

from api_client import APIClient
from config import API_BASE_URL, INTERNAL_INGEST_TOKEN
from monitor import RunLogger, main_loop, run_cycle


def _build_client() -> APIClient:
    return APIClient(base_url=API_BASE_URL, token=INTERNAL_INGEST_TOKEN)


def main() -> None:
    parser = argparse.ArgumentParser(description="autoReportUpload service")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="识别文件但不写入数据库，不移动文件",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="只运行一次扫描，不进入定时循环（用于测试）",
    )
    parser.add_argument(
        "--mode",
        choices=["watchdog", "polling"],
        default="watchdog",
        help="watchdog: 文件系统事件监控（默认）; polling: 旧版定时轮询",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("模式: dry-run（只识别，不入库，不移动文件）")

    client = _build_client()

    if args.once:
        logs_dir = Path(__file__).parent / "logs"
        logger = RunLogger(logs_dir)
        logger.info(">>> 一次性扫描模式")

        stats = run_cycle(logger, client, dry_run=args.dry_run)
        logger.info(
            f"完成: {stats['files_seen']} 文件, "
            f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
        )
        return

    main_loop(api_client=client, dry_run=args.dry_run, mode=args.mode)


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
"""
autoReportUpload — entry point.

Usage:
    python run.py                  # Normal mode (启动时全盘扫描，watchdog 持续监控新文件)
    python run.py --dry-run        # Dry-run: recognize files only, no DB writes, no file moves
    python run.py --once           # Run once (no periodic loop), useful for testing
    python run.py --mode polling   # 旧版定时轮询模式（每 5 分钟）
"""

import argparse
import sys


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

    if args.once:
        from pathlib import Path
        from monitor import (
            RunLogger,
            WatchdogDispatcher,
            _acquire_instance_lock,
            sweep_to_dispatcher,
        )

        logs_dir = Path(__file__).parent / "logs"
        logger = RunLogger(logs_dir)
        logger.info(">>> 一次性扫描模式")

        # Same single-instance guard as the daemon: a manual sweep racing a live
        # watchdog would fight over the same files and DB unique keys.
        lock = _acquire_instance_lock(logger)
        if lock is None:
            sys.exit(1)

        dispatcher = WatchdogDispatcher(logger, dry_run=args.dry_run)
        stats = sweep_to_dispatcher(logger, dispatcher)
        dispatcher.stop()
        logger.info(
            f"完成: {stats['files_seen']} 文件, "
            f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
        )
        print(f"\n日志文件: {logger.log_file}")
        sys.exit(0)

    from monitor import main_loop
    main_loop(dry_run=args.dry_run, mode=args.mode)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
autoReportUpload — entry point.

Usage:
    python run.py                  # Normal mode: recognize, persist, move files
    python run.py --dry-run        # Dry-run: recognize files only, no DB writes, no file moves
    python run.py --once           # Run once (no periodic loop), useful for testing
"""

import argparse
import sys

from monitor import main_loop


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
    args = parser.parse_args()

    if args.dry_run:
        print("模式: dry-run（只识别，不入库，不移动文件）")

    if args.once:
        from pathlib import Path
        from datetime import datetime
        from config import CHECK_INTERVAL_MINUTES, IGNORED_DIRS, PROCESSED_SUBDIR, PROJECTS, SUPPORTED_EXTENSIONS, WATCH_ROOT
        from db import get_db_session
        from processor import process_file
        from monitor import RunLogger

        logs_dir = Path(__file__).parent / "logs"
        logger = RunLogger(logs_dir)
        logger.info(">>> 一次性扫描模式")

        from monitor import run_cycle
        stats = run_cycle(logger, dry_run=args.dry_run)
        logger.info(
            f"完成: {stats['files_seen']} 文件, "
            f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
        )
        print(f"\n日志文件: {logger.log_file}")
        sys.exit(0)

    main_loop(dry_run=args.dry_run)


if __name__ == "__main__":
    main()

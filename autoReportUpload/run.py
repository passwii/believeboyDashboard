#!/usr/bin/env python3
"""
autoReportUpload — entry point.

Usage:
    python run.py                  # Normal mode (uses .env AUTO_REPORT_ENV setting)
    python run.py --env local      # Force local mode (localhost DB/API, no file moves)
    python run.py --env production # Force production mode (remote DB/API, move files)
    python run.py --dry-run        # Dry-run: recognize files only, no DB writes, no file moves
    python run.py --once           # Run once (no periodic loop), useful for testing
"""

import argparse
import os
import sys

# ── Parse known args first so --env can override before config is loaded ──────
_parser = argparse.ArgumentParser(allow_abbrev=False)
_parser.add_argument("--env", choices=["local", "production"], default=None)
_parser.add_argument("--dry-run", action="store_true")
_parser.add_argument("--once", action="store_true")
_args, _ = _parser.parse_known_args()

if _args.env:
    os.environ["AUTO_REPORT_ENV"] = _args.env

from monitor import main_loop


def main() -> None:
    parser = argparse.ArgumentParser(description="autoReportUpload service")
    parser.add_argument(
        "--env",
        choices=["local", "production"],
        default=None,
        help="运行环境: local (本地) 或 production (生产)；默认读取 .env",
    )
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

    if args.env:
        os.environ["AUTO_REPORT_ENV"] = args.env

    # Import config after env override so IS_LOCAL/IS_PRODUCTION reflect the right mode
    from config import IS_LOCAL, IS_PRODUCTION
    env_label = "本地(local)" if IS_LOCAL else "生产(production)"
    print(f"[启动] 环境: {env_label}")

    if args.dry_run:
        print("模式: dry-run（只识别，不入库，不移动文件）")

    if args.once:
        from pathlib import Path
        from monitor import RunLogger, run_cycle

        logs_dir = Path(__file__).parent / "logs"
        logger = RunLogger(logs_dir)
        logger.info(">>> 一次性扫描模式")

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

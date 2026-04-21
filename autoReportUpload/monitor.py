"""
Monitor loop: scan project folders and process new files.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path

from config import CHECK_INTERVAL_MINUTES, IGNORED_DIRS, PROCESSED_SUBDIR, PROJECTS, SUPPORTED_EXTENSIONS, WATCH_ROOT
from db import get_db_session
from processor import ProcessResult, process_file


class RunLogger:
    """Logs run results to a timestamped file."""

    def __init__(self, logs_dir: Path):
        self.logs_dir = logs_dir
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = self.logs_dir / f"run_{self.run_ts}.log"

        self.logger = logging.getLogger(f"autorun.{self.run_ts}")
        self.logger.setLevel(logging.INFO)
        self.logger.handlers.clear()

        # File handler
        fh = logging.FileHandler(self.log_path, encoding="utf-8")
        fh.setLevel(logging.INFO)
        # Console handler
        ch = logging.StreamHandler()
        ch.setLevel(logging.INFO)

        fmt = logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%H:%M:%S")
        fh.setFormatter(fmt)
        ch.setFormatter(fmt)
        self.logger.addHandler(fh)
        self.logger.addHandler(ch)

    def info(self, msg: str) -> None:
        self.logger.info(msg)

    def result(self, file_path: Path, project: str, result: ProcessResult) -> None:
        if result.skipped:
            self.logger.info(f"  SKIP  [{project}] {file_path.name}  {result.reason}")
        elif result.success:
            self.logger.info(
                f"  OK    [{project}] {file_path.name}  "
                f"type={result.report_type}  rows={result.row_count}  id={result.source_id}"
            )
        else:
            self.logger.error(
                f"  FAIL  [{project}] {file_path.name}  {result.error}"
            )

    @property
    def log_file(self) -> Path:
        return self.log_path


def _collect_files(project_dir: Path) -> list[Path]:
    """Return top-level files in project_dir that are supported and not already processed."""
    if not project_dir.is_dir():
        return []

    collected = []
    for entry in project_dir.iterdir():
        if entry.is_dir():
            # Skip the processed subfolder itself
            if entry.name == PROCESSED_SUBDIR or entry.name in IGNORED_DIRS:
                continue
            continue
        if entry.suffix.lower() in SUPPORTED_EXTENSIONS:
            collected.append(entry)
    return collected


def run_cycle(logger: RunLogger, dry_run: bool = False) -> dict:
    """Scan all project folders and process new files. Returns summary stats."""
    stats = {"projects": 0, "files_seen": 0, "skipped": 0, "success": 0, "failed": 0}

    for project_name in PROJECTS:
        project_dir = WATCH_ROOT / project_name
        if not project_dir.exists():
            logger.info(f"[{project_name}]  目录不存在，跳过")
            continue

        files = _collect_files(project_dir)
        if not files:
            continue

        stats["projects"] += 1
        logger.info(f"\n=== [{project_name}] 发现 {len(files)} 个文件 ===")

        db = get_db_session()
        try:
            for file_path in sorted(files):
                stats["files_seen"] += 1
                result = process_file(file_path, project_name, db, dry_run=dry_run)
                logger.result(file_path, project_name, result)
                if result.skipped:
                    stats["skipped"] += 1
                elif result.success:
                    stats["success"] += 1
                else:
                    stats["failed"] += 1
        finally:
            db.close()

    return stats


def main_loop(dry_run: bool = False) -> None:
    """Full main loop: initial global scan then periodic incremental checks."""
    logs_dir = Path(__file__).parent / "logs"
    logger = RunLogger(logs_dir)

    logger.info("=" * 60)
    logger.info("autoReportUpload 服务启动")
    logger.info(f"监控目录: {WATCH_ROOT}")
    logger.info(f"项目列表: {', '.join(PROJECTS)}")
    logger.info(f"检查间隔: {CHECK_INTERVAL_MINUTES} 分钟")
    logger.info(f"dry_run: {dry_run}")
    logger.info("=" * 60)

    # ── Initial global scan ──────────────────────────────────────────────
    logger.info("\n>>> 首次运行：全局扫描所有项目目录")
    stats = run_cycle(logger, dry_run=dry_run)
    logger.info(
        f"\n全局扫描完成: {stats['files_seen']} 文件, "
        f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
    )

    # ── Periodic loop ───────────────────────────────────────────────────
    interval_secs = CHECK_INTERVAL_MINUTES * 60
    while True:
        logger.info(f"\n等待 {CHECK_INTERVAL_MINUTES} 分钟后下次检查 ...")
        time.sleep(interval_secs)

        logger.info("\n>>> 定时扫描开始")
        stats = run_cycle(logger, dry_run=dry_run)
        logger.info(
            f"定时扫描完成: {stats['files_seen']} 文件, "
            f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
        )

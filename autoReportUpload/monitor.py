"""
Monitor loop: scan project folders and process new files.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path

from config import CHECK_INTERVAL_MINUTES, IGNORED_DIRS, IS_LOCAL, IS_WINDOWS, PROCESSED_SUBDIR, PROJECTS, SUPPORTED_EXTENSIONS, WATCH_ROOT
from db import get_db_session
from processor import ProcessResult, process_file
try:
    from client import report_scan_start, report_scan_progress, report_scan_complete, report_scan_error
    HAS_CLIENT = True
except ImportError:
    HAS_CLIENT = False


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
    task_id = None

    if HAS_CLIENT:
        task_id = report_scan_start(", ".join(PROJECTS))
        report_scan_progress(task_id, f"扫描 {len(PROJECTS)} 个项目目录", 0, 0)

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
            for i, file_path in enumerate(sorted(files)):
                stats["files_seen"] += 1
                if HAS_CLIENT:
                    report_scan_progress(task_id, f"处理: {file_path.name}", stats["files_seen"], i + 1)
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

    if HAS_CLIENT:
        if stats["failed"] > 0:
            report_scan_error(task_id, f"{stats['failed']} 个文件处理失败")
        else:
            report_scan_complete(task_id, stats)

    return stats


def _start_watchdog_logger(logger: RunLogger, dry_run: bool):
    """启动 watchdog 事件监控，文件创建立即触发处理（watchdog 模式）"""
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler

    class ReportFileHandler(FileSystemEventHandler):
        def __init__(self, logger: RunLogger, dry_run: bool):
            self.logger = logger
            self.dry_run = dry_run
            self._pending: dict[str, float] = {}  # debounce: 忽略 2 秒内重复事件

        def on_created(self, event):
            if event.is_directory:
                return
            file_path = Path(event.src_path)
            if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                return

            # debounce
            key = str(file_path)
            now = time.time()
            if key in self._pending and now - self._pending[key] < 2:
                return
            self._pending[key] = now

            # 判断属于哪个项目
            try:
                project_name = file_path.parent.name
                # 明确排除 processed/ 子目录，防止处理已归档文件
                if project_name == PROCESSED_SUBDIR or project_name not in PROJECTS:
                    return
            except Exception:
                return

            logger.info(f"  [watchdog] 检测到新文件: {file_path.name}")
            db = get_db_session()
            try:
                result = process_file(file_path, project_name, db, dry_run=self.dry_run)
                logger.result(file_path, project_name, result)
            finally:
                db.close()

    handler = ReportFileHandler(logger, dry_run)
    observer = Observer()
    for project_name in PROJECTS:
        project_dir = WATCH_ROOT / project_name
        if project_dir.exists():
            observer.schedule(handler, str(project_dir), recursive=False)
    observer.start()
    logger.info(f"watchdog 监控已启动，监控目录: {WATCH_ROOT}")
    return observer


def _main_loop_polling(logger: RunLogger, dry_run: bool) -> None:
    """原有定时轮询逻辑（polling 模式）"""
    logger.info("\n>>> 首次运行：全局扫描所有项目目录")
    stats = run_cycle(logger, dry_run=dry_run)
    logger.info(
        f"\n全局扫描完成: {stats['files_seen']} 文件, "
        f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
    )

    interval_secs = CHECK_INTERVAL_MINUTES * 60
    while True:
        time.sleep(interval_secs)

        stats = run_cycle(logger, dry_run=dry_run)
        if stats["files_seen"] > 0:
            logger.info(
                f"定时扫描完成: {stats['files_seen']} 文件, "
                f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
            )


def main_loop(dry_run: bool = False, mode: str = "watchdog") -> None:
    """Full main loop: initial global scan then periodic incremental checks."""
    logs_dir = Path(__file__).parent / "logs"
    logger = RunLogger(logs_dir)

    platform_label = "Windows" if IS_WINDOWS else "macOS"
    env_label = "本地(local)" if IS_LOCAL else "生产(production)"
    move_label = "不移动" if IS_LOCAL else "移动到 processed/"
    logger.info("=" * 60)
    logger.info("autoReportUpload 服务启动")
    logger.info(f"平台: {platform_label}  环境: {env_label}  监控目录: {WATCH_ROOT}")
    logger.info(f"项目列表: {', '.join(PROJECTS)}")
    logger.info(f"检查间隔: {CHECK_INTERVAL_MINUTES} 分钟  文件处理: {move_label}")
    logger.info(f"dry_run: {dry_run}")
    logger.info("=" * 60)

    if mode == "watchdog":
        logger.info("监控模式: watchdog（文件事件触发）")
        observer = _start_watchdog_logger(logger, dry_run)
        try:
            while True:
                time.sleep(5)
        except KeyboardInterrupt:
            observer.stop()
        observer.join()
    else:
        logger.info(f"监控模式: polling（每 {CHECK_INTERVAL_MINUTES} 分钟轮询）")
        _main_loop_polling(logger, dry_run)

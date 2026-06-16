"""
Monitor loop: scan project folders and process new files.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from pathlib import Path

from config import AD_PROCESSED_SUBDIR, CHECK_INTERVAL_MINUTES, IGNORED_DIRS, PROCESSED_SUBDIR, PROJECTS, SUPPORTED_EXTENSIONS, WATCH_ROOT
from db import Session, check_db_health, get_db_session, get_db_session_with_retry, reconnect_engine
from processor import ProcessResult, process_file


_A_TABLE_REPORT_TYPE_LABELS: dict[str, str] = {
    "sales_report": "所有订单",
    "return_report": "退货报告",
    "inventory_report": "库存报告",
    "business_report": "业务报告",
    "payment_report": "付款报告",
}


import unicodedata
import shutil

class _TableResultFormatter(logging.Formatter):
    """Console formatter: renders ProcessResult lines as a colourised table row.

    Non-result messages (everything else) are passed through unchanged.
    """

    # ── ANSI colour codes ────────────────────────────────────────────────────
    _BOLD    = "\033[1m"
    _RESET   = "\033[0m"
    _DIM     = "\033[2m"
    _GREEN   = "\033[92m"
    _YELLOW  = "\033[93m"
    _RED     = "\033[91m"
    _CYAN    = "\033[96m"
    _MAGENTA = "\033[95m"

    _SEP  = "│"
    _HSEP = "─"

    # Column widths (display columns, not char count)
    _COL_STATUS  = 6
    _COL_COUNTRY = 4
    _COL_PROJECT = 10
    _COL_REPORT  = 18
    _COL_DATE    = 10

    @property
    def _COL_NOTE(self) -> int:
        """Note column width = terminal width minus fixed columns and separators."""
        fixed = self._COL_STATUS + self._COL_COUNTRY + self._COL_PROJECT \
              + self._COL_REPORT + self._COL_DATE
        # 7 separators: after each of the 6 columns + leading separator on row_sep
        tw = shutil.get_terminal_size((80, 24)).columns
        return max(10, tw - fixed - 7)

    @staticmethod
    def _dw(s: str) -> int:
        """Display width: CJK/ambiguous chars count as 2, others as 1."""
        w = 0
        for ch in s:
            eaw = unicodedata.east_asian_width(ch)
            w += 2 if eaw in ("W", "F") else 1
        return w

    def _trunc(self, s: str, w: int) -> str:
        if self._dw(s) <= w:
            return s
        out = []
        cur = 0
        for ch in s:
            cw = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
            if cur + cw > w - 1:
                break
            out.append(ch)
            cur += cw
        return "".join(out) + "…"

    def _pad(self, s: str, w: int) -> str:
        return s + " " * max(0, w - self._dw(s))

    def _row_sep(self) -> str:
        """Dim horizontal line matching the table column structure."""
        cross = "┼"
        cols = [self._COL_STATUS, self._COL_COUNTRY, self._COL_PROJECT,
                self._COL_REPORT, self._COL_DATE, self._COL_NOTE]
        s = cross.join(self._HSEP * w for w in cols)
        return self._DIM + s + self._RESET

    def _header(self) -> str:
        r = self._RESET
        cyan = self._BOLD + self._CYAN
        def h(label, w):
            return f"{cyan}{self._pad(label, w)}{r}"
        divider = (
            f"{self._DIM}"
            + self._pad("──", self._COL_STATUS).replace(" ", self._HSEP) + self._SEP
            + self._pad("──", self._COL_COUNTRY).replace(" ", self._HSEP) + self._SEP
            + self._pad("──", self._COL_PROJECT).replace(" ", self._HSEP) + self._SEP
            + self._pad("──", self._COL_REPORT).replace(" ", self._HSEP) + self._SEP
            + self._pad("──", self._COL_DATE).replace(" ", self._HSEP) + self._SEP
            + self._pad("──", self._COL_NOTE).replace(" ", self._HSEP)
            + self._RESET
        )
        return (
            f"{cyan}{self._pad('状态', self._COL_STATUS)}{self._SEP}"
            f"{h('国家', self._COL_COUNTRY)}{self._SEP}"
            f"{h('项目', self._COL_PROJECT)}{self._SEP}"
            f"{h('报表类型', self._COL_REPORT)}{self._SEP}"
            f"{h('日期', self._COL_DATE)}{self._SEP}"
            f"{h('备注', self._COL_NOTE)}{self._RESET}"
            f"\n{divider}"
        )

    def format(self, record: logging.LogRecord) -> str:
        msg: str = record.getMessage()

        # Only format pipe-delimited result lines
        if msg and len(msg) > 3 and msg[2] == "|":
            parts = msg.split("|")
            status_raw = parts[0]

            if status_raw == "OK":
                return self._format_row("✓ OK",   self._GREEN,  parts)
            elif status_raw == "跳过":
                return self._format_row("⏭ 跳过", self._YELLOW, parts)
            elif status_raw == "FAIL":
                return self._format_row("✗ FAIL", self._RED,   parts)

        # Not a result line — return as-is (raw text, no timestamp prefix)
        return msg

    def _format_row(self, status: str, colour: str, parts: list[str]) -> str:
        r, sep = self._RESET, self._SEP

        country  = self._pad(parts[1] if len(parts) > 1 else "-", self._COL_COUNTRY)
        project  = self._pad(self._trunc(parts[2] if len(parts) > 2 else "-", self._COL_PROJECT), self._COL_PROJECT)
        report   = self._pad(self._trunc(parts[3] if len(parts) > 3 else "-", self._COL_REPORT),  self._COL_REPORT)
        date_str = self._pad(parts[4] if len(parts) > 4 else "-", self._COL_DATE)
        note     = self._trunc(" ".join(parts[5:]) if len(parts) > 5 else "", self._COL_NOTE)

        c = colour + self._BOLD
        return (
            f"{c}{self._pad(status, self._COL_STATUS)}{r}{sep}"
            f"{self._DIM}{country}{r}{sep}"
            f"{self._MAGENTA}{project}{r}{sep}"
            f"{colour}{report}{r}{sep}"
            f"{self._CYAN}{date_str}{r}{sep}"
            f"{self._DIM}{note}{r}"
            f"\n{self._row_sep()}"
        )


class RunLogger:
    """Logs run results to a timestamped file + styled console output."""

    def __init__(self, logs_dir: Path):
        self.logs_dir = logs_dir
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.run_ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.log_path = self.logs_dir / f"run_{self.run_ts}.log"
        self._table_header_printed = False

        self.logger = logging.getLogger(f"autorun.{self.run_ts}")
        self.logger.setLevel(logging.DEBUG)
        self.logger.handlers.clear()

        # ── File handler (pipe-delimited, easy to parse) ─────────────────────
        fh = logging.FileHandler(self.log_path, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh_fmt = logging.Formatter(
            "%(asctime)s  %(levelname)-8s  %(message)s",
            datefmt="%H:%M:%S",
        )
        fh.setFormatter(fh_fmt)
        self.logger.addHandler(fh)

        # ── Console handler (table-styled) ───────────────────────────────────
        ch = logging.StreamHandler()
        ch.setLevel(logging.DEBUG)
        ch.setFormatter(_TableResultFormatter())
        self.logger.addHandler(ch)

    def debug(self, msg: str, *args) -> None:
        self.logger.debug(msg, *args)

    def info(self, msg: str, *args) -> None:
        self.logger.info(msg, *args)

    def warning(self, msg: str, *args) -> None:
        self.logger.warning(msg, *args)

    def error(self, msg: str, *args) -> None:
        self.logger.error(msg, *args)

    def result(self, file_path: Path, project: str, result: ProcessResult) -> None:
        # 状态标签
        if result.skipped:
            status = "跳过"
        elif result.success:
            status = "OK"
        else:
            status = "FAIL"

        # 国家
        country = result.country or "-"

        # 报表类型中文（优先用 report_label；A 表 report_type 映射为中文）
        report_type_cn = (
            result.report_label
            or _A_TABLE_REPORT_TYPE_LABELS.get(result.report_type)
            or result.report_type
            or "未知报表"
        )

        # 报告日期（压缩格式：单日 MM-DD，区间同月 MM-DD~DD，跨月 MM-DD~MM-DD）
        def _short_date(ds: str) -> str:
            """'2026-06-05' → '06-05'"""
            return ds[5:] if len(ds) >= 10 else ds

        if result.detected_start_date and result.detected_end_date:
            if result.detected_start_date == result.detected_end_date:
                report_date = _short_date(result.detected_start_date)
            else:
                sd, ed = result.detected_start_date, result.detected_end_date
                if sd[:7] == ed[:7]:  # same year-month
                    report_date = f"{_short_date(sd)}~{ed[8:]}"
                else:
                    report_date = f"{_short_date(sd)}~{_short_date(ed)}"
        elif result.detected_start_date:
            report_date = _short_date(result.detected_start_date)
        elif result.detected_end_date:
            report_date = _short_date(result.detected_end_date)
        else:
            report_date = "-"

        if result.success:
            self.logger.info(
                f"{status}|{country}|{project}|{report_type_cn}|{report_date}"
            )
        elif result.skipped:
            self.logger.info(
                f"{status}|{country}|{project}|{report_type_cn}|{report_date}|{result.reason}"
            )
        else:
            self.logger.error(
                f"{status}|{country}|{project}|{report_type_cn}|{report_date}|{result.error}"
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
            # Skip the processed subfolders themselves (general + ad-specific)
            if (
                entry.name == PROCESSED_SUBDIR
                or entry.name == AD_PROCESSED_SUBDIR
                or entry.name in IGNORED_DIRS
            ):
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
            continue

        files = _collect_files(project_dir)
        if not files:
            continue

        stats["projects"] += 1
        db, needs_reconnect = get_db_session_with_retry()
        if db is None:
            # DB 完全不可用，跳过此轮
            logger.error(f"[DB] 数据库连接失败，跳过 [{project_name}] 的文件处理")
            stats["failed"] += len(files)
            if needs_reconnect:
                reconnect_engine()
            continue

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
        except Exception as exc:
            logger.error(f"[{project_name}] 处理循环异常: {exc}")
            stats["failed"] += 1
        finally:
            db.close()

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
            self._db_session: Session | None = None
            self._last_db_check: float = 0
            self._db_check_interval: float = 60  # 每 60 秒检查一次 DB 健康状态

        def _get_db_session(self) -> Session | None:
            """获取 DB session，带健康检查和重连机制"""
            now = time.time()
            if now - self._last_db_check > self._db_check_interval:
                self._last_db_check = now
                if not check_db_health():
                    reconnect_engine()
                    logger.warning("[DB] 健康检查失败，已重建连接池")

            db, needs_reconnect = get_db_session_with_retry()
            if db is None and needs_reconnect:
                reconnect_engine()
                logger.warning("[DB] 重新获取 session 失败，已重建连接池")
                db, _ = get_db_session_with_retry()

            return db

        def _close_session(self) -> None:
            """安全关闭 session"""
            if self._db_session is not None:
                try:
                    self._db_session.close()
                except Exception:
                    pass
                self._db_session = None

        def on_created(self, event):
            if event.is_directory:
                return
            file_path = Path(event.src_path)
            if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                return

            key = str(file_path)
            now = time.time()
            if key in self._pending and now - self._pending[key] < 2:
                return
            self._pending[key] = now

            try:
                project_name = file_path.parent.name
                if (
                    project_name == PROCESSED_SUBDIR
                    or project_name == AD_PROCESSED_SUBDIR
                    or project_name not in PROJECTS
                ):
                    return
            except Exception:
                return

            db = self._get_db_session()
            if db is None:
                logger.error(f"  [watchdog] 无法获取数据库连接，跳过文件: {file_path.name}")
                return

            try:
                result = process_file(file_path, project_name, db, dry_run=self.dry_run)
                logger.result(file_path, project_name, result)

                if result.skipped and "未匹配任何报表类型" in (result.reason or ""):
                    self.logger.info(f"  [watchdog] 5 秒后重试未识别文件: {file_path.name}")
                    time.sleep(5)
                    result = process_file(file_path, project_name, db, dry_run=self.dry_run)
                    logger.result(file_path, project_name, result)
            except Exception as exc:
                logger.error(f"  [watchdog] 处理文件异常: {file_path.name}  {exc}")
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

    logger.info("=" * 60)
    logger.info("autoReportUpload 服务启动")
    logger.info(f"监控目录: {WATCH_ROOT}")
    logger.info(f"项目列表: {', '.join(PROJECTS)}")
    logger.info(f"检查间隔: {CHECK_INTERVAL_MINUTES} 分钟  dry_run: {dry_run}")
    logger.info("=" * 60)

    if mode == "watchdog":
        logger.info("监控模式: watchdog（文件事件触发）")
        # ── 启动前先做一次全盘扫描 ──────────────────────────────────────────
        stats = run_cycle(logger, dry_run=dry_run)
        logger.info(
            f"全盘扫描完成: {stats['files_seen']} 文件, "
            f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
        )
        # ── 然后启动 watchdog 持续监控新文件 ─────────────────────────────────
        observer = _start_watchdog_logger(logger, dry_run)
        logger.info("watchdog 监控已启动，持续监听新文件...")
        try:
            while True:
                time.sleep(5)
        except KeyboardInterrupt:
            observer.stop()
        observer.join()
    else:
        logger.info(f"监控模式: polling（每 {CHECK_INTERVAL_MINUTES} 分钟轮询）")
        _main_loop_polling(logger, dry_run)

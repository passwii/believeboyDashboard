"""
Monitor loop: scan project folders and process new files.
"""

from __future__ import annotations

import fcntl
import logging
import os
import queue
import threading
import time
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Callable

from config import (
    AD_PROCESSED_SUBDIR,
    CHECK_INTERVAL_MINUTES,
    COUNTRY_SUBFOLDERS,
    DRAIN_TIMEOUT_SECONDS,
    IGNORED_DIRS,
    MAX_FILE_ATTEMPTS,
    PROCESSED_SUBDIR,
    PROJECTS,
    STABLE_POLL_SECONDS,
    STABLE_SAMPLES,
    SUPPORTED_EXTENSIONS,
    WATCH_WORKERS,
    WATCH_ROOT,
    resolve_project_dir,
)
from db import Session, check_db_health, get_db_session, get_db_session_with_retry, reconnect_engine
from processor import ProcessResult, process_file
from recognition import B_TABLE_AD_REPORT_TYPES
from models import AutoReportUploadLog


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

    def result(
        self,
        file_path: Path,
        project: str,
        result: ProcessResult,
        *,
        db: Session | None = None,
        duration_seconds: float | None = None,
    ) -> None:
        # 状态标签
        if result.skipped:
            status_label = "跳过"
            db_status = "skipped"
        elif result.success:
            status_label = "OK"
            db_status = "success"
        else:
            status_label = "FAIL"
            db_status = "failed"

        # 国家
        country = result.country or "-"

        # 报表类型中文（先查 A 表 report_type 映射；B 表 ad 报告 result.report_label 自带中文）
        report_type_cn = (
            _A_TABLE_REPORT_TYPE_LABELS.get(result.report_type or "")
            or result.report_label
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
                f"{status_label}|{country}|{project}|{report_type_cn}|{report_date}"
            )
        elif result.skipped:
            self.logger.info(
                f"{status_label}|{country}|{project}|{report_type_cn}|{report_date}|{result.reason}"
            )
        else:
            self.logger.error(
                f"{status_label}|{country}|{project}|{report_type_cn}|{report_date}|{result.error}"
            )

        # ── Write to DB ──────────────────────────────────────────────────
        if db is not None:
            try:
                # Determine source table: B-table ad types go to C (ad_upload_files),
                # everything else goes to A (analysis_source_files).
                source_table = (
                    "C" if result.report_type in B_TABLE_AD_REPORT_TYPES else "A"
                ) if result.report_type else None

                db.add(AutoReportUploadLog(
                    run_id=self.run_ts,
                    status=db_status,
                    country=country,
                    project_name=project,
                    report_type_label=report_type_cn,
                    report_date_display=report_date,
                    report_type=result.report_type,
                    original_filename=file_path.name,
                    source_id=result.source_id,
                    source_table=source_table,
                    row_count=result.row_count,
                    detected_start_date=result.detected_start_date,
                    detected_end_date=result.detected_end_date,
                    duration_seconds=duration_seconds,
                    error_message=result.error or (result.reason if not result.success else None),
                    note=result.reason if result.success else None,
                ))
                db.commit()
            except Exception as exc:
                self.logger.warning(f"[DB_LOG] 写入运行时日志失败: {exc}")
                db.rollback()

    @property
    def log_file(self) -> Path:
        return self.log_path


def _collect_files(project_dir: Path) -> list[Path]:
    """Return files in project_dir (root + country subfolders, e.g. 美国) that are
    supported and not already processed."""
    if not project_dir.is_dir():
        return []

    collected = []
    roots = [project_dir] + [
        project_dir / sub for sub in COUNTRY_SUBFOLDERS if (project_dir / sub).is_dir()
    ]
    for root in roots:
        for entry in root.iterdir():
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


class SingleInstanceLock:
    """Advisory exclusive lock so only one autoReportUpload daemon runs per host.

    Two live instances sweep the same RPA folders concurrently and race on the
    DB unique keys — the 2026-10-12 double-instance run produced 206 FAIL rows
    (``ad_upload_files_scope_version_key`` x111, ``analysis_sources_period_version_key``
    x70) plus 43 ``Errno 2`` file-stealing races. The lock file also stores the
    holder PID so a rejected start can name the process that owns the service.
    """

    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def acquire(self) -> bool:
        """Try to take the lock. Returns False when another process holds it."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = self.path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        fh.seek(0)
        fh.truncate()
        fh.write(f"{os.getpid()}\n")
        fh.flush()
        self._fh = fh
        return True

    def holder_pid(self) -> str | None:
        """PID written by whoever holds the lock, if readable."""
        try:
            pid = self.path.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return pid or None

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        finally:
            self._fh.close()
            self._fh = None


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

                t0 = time.time()
                result = process_file(file_path, project_name, db, dry_run=dry_run)
                duration = time.time() - t0
                logger.result(file_path, project_name, result, db=db, duration_seconds=duration)
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


class IncrementalRescanThread(threading.Thread):
    """Background safety net: re-scan every ``CHECK_INTERVAL_MINUTES``.

    The watchdog only reacts to filesystem events, so anything the observer
    missed (DB outage, dropped event, a file written during the startup sweep)
    would otherwise wait for the next manual restart — on 2026-10-16 that gap
    was 2.5h and the whole 15:xx batch sat unprocessed. The rescan also gates on
    one cheap ``check_db_health`` probe: when the DB is unreachable it skips the
    *entire* round instead of burning ~44s per file on doomed retries.

    The round is handed to the shared :class:`WatchdogDispatcher` so the rescan
    rides the same worker pool (and the same dedup set) as the event stream —
    files already in flight are not queued twice.
    """

    def __init__(
        self,
        logger: RunLogger,
        dry_run: bool,
        interval_secs: float,
        dispatcher: WatchdogDispatcher,
    ):
        super().__init__(daemon=True, name="autorun-rescan")
        self.logger = logger
        self.dry_run = dry_run
        self.interval_secs = interval_secs
        self.dispatcher = dispatcher
        self._stop_event = threading.Event()
        self._round = 0

    def run_once(self) -> dict | None:
        """One rescan round. Returns stats, or None when the DB gate blocks it."""
        if not check_db_health():
            self.logger.warning("[补扫] 数据库健康检查失败，本轮整轮跳过（不逐文件重试）")
            return None
        self._round += 1
        pending = collect_all_files()
        batch = f"rescan-{id(self)}-{self._round}"
        queued = [
            pair for pair in pending if self.dispatcher.submit(*pair, batch=batch)
        ]
        if not queued:
            return {
                "projects": 0, "files_seen": 0,
                "success": 0, "skipped": 0, "failed": 0,
            }
        self.logger.info(f"[补扫] 入队 {len(queued)} 文件，等待处理完成后汇报")
        self.dispatcher.wait_until_idle(timeout=DRAIN_TIMEOUT_SECONDS)
        stats = self.dispatcher.take_batch_stats(batch)
        return {
            "projects": len({name for _, name in queued}),
            "files_seen": len(queued),
            "success": stats["success"],
            "skipped": stats["skipped"],
            "failed": stats["failed"],
        }

    def run(self) -> None:
        while not self._stop_event.wait(self.interval_secs):
            try:
                stats = self.run_once()
            except Exception as exc:  # noqa: BLE001 - rescan must never kill the daemon
                self.logger.error(f"[补扫] 本轮异常: {exc}")
                continue
            if stats is not None and stats["files_seen"] > 0:
                self.logger.info(
                    f"增量补扫完成: {stats['files_seen']} 文件, "
                    f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
                )

    def stop(self) -> None:
        self._stop_event.set()


class DbUnavailable(RuntimeError):
    """Raised when no DB session can be obtained (caller decides whether to retry)."""


def _eligible_project_name(file_path: Path) -> str | None:
    """Project name for a watched file, or None when the path is not in scope.

    ``processed`` / ``广告Processed`` archives and projects outside PROJECTS are
    filtered out; country subfolders (e.g. ``美国``) resolve back to the project.
    """
    try:
        project_name = resolve_project_dir(file_path).name
    except Exception:
        return None
    if (
        project_name == PROCESSED_SUBDIR
        or project_name == AD_PROCESSED_SUBDIR
        or project_name not in PROJECTS
    ):
        return None
    return project_name


def _process_one(
    logger: RunLogger,
    file_path: Path,
    project_name: str,
    dry_run: bool,
) -> ProcessResult:
    """Process a single file on its own DB session (safe to call concurrently)."""
    db, needs_reconnect = get_db_session_with_retry()
    if db is None:
        if needs_reconnect:
            reconnect_engine()
        raise DbUnavailable(f"无法获取数据库连接: {file_path.name}")
    try:
        t0 = time.time()
        result = process_file(file_path, project_name, db, dry_run=dry_run)
        logger.result(
            file_path, project_name, result,
            db=db, duration_seconds=time.time() - t0,
        )
        return result
    finally:
        db.close()


def _file_fingerprint(path: Path) -> tuple[int, int] | None:
    """(size, mtime_ns) for an existing regular file, else None."""
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_size, st.st_mtime_ns)


def wait_for_stable(
    path: Path,
    *,
    samples: int = STABLE_SAMPLES,
    poll_seconds: float = STABLE_POLL_SECONDS,
    fingerprint: Callable[[Path], tuple[int, int] | None] = _file_fingerprint,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Block until ``path`` stops changing for ``samples`` consecutive reads.

    RPA drops a file and then keeps writing it, so an ``on_created`` event alone
    does not mean the content is complete — reading too early yields
    "未匹配任何报表类型" for a file that is actually fine.

    macOS is the constraint here: watchdog's FSEvents observer never emits
    ``FileClosedEvent`` (only Linux inotify does), so there is no close signal to
    wait on and stability must be inferred by sampling. Returns False when the
    file vanished (typically already processed and archived by the sweep).
    """
    samples = max(1, samples)
    last = fingerprint(path)
    if last is None:
        return False
    unchanged = 0
    while unchanged < samples - 1:
        sleep(poll_seconds)
        current = fingerprint(path)
        if current is None:
            return False
        if current == last:
            unchanged += 1
        else:
            last = current
            unchanged = 0
    return True


@dataclass(frozen=True)
class _PendingFile:
    """One queued file plus the retry bookkeeping travelling with it.

    ``attempt`` counts *content* retries (bounded by ``max_attempts``) while
    ``db_attempt`` counts DB-outage retries — a dead database is an environment
    problem and must not consume a file's retry budget.
    """

    path: Path
    project_name: str
    attempt: int = 1
    db_attempt: int = 1
    batch: str | None = None


class WatchdogDispatcher:
    """Fixed-size worker pool draining a queue of newly discovered report files.

    Each file is handled on its own thread and its own DB session. Since the
    per-file cost is dominated by cross-network DB round trips (~14s median
    measured on 2026-10-16, independent of file size), three workers roughly
    triple throughput; the previous code processed everything inline on the
    watchdog event thread, so one slow file stalled every other arrival.

    Dedup + bounded retry: a path is skipped while queued or already finished,
    but a file whose content is not yet complete (or whose DB write failed) is
    retried up to ``MAX_FILE_ATTEMPTS`` times before being reported as FAIL and
    left on disk — replacing the old silent drop.
    """

    # How long a finished path stays "already handled".
    #
    # Deliberately a TTL rather than a permanent set: files that fail stay on
    # disk, and the rescan must be able to pick them up again next round — a
    # permanent memory would swallow exactly the backlog the rescan exists to
    # recover. Ten minutes comfortably covers one sweep plus the burst of
    # duplicate FSEvents that follow a single drop.
    _DEDUP_TTL_SECONDS = 600.0
    # Files we gave up on stay on disk, so a plain TTL would have the rescan
    # re-attempt the same broken file every round forever (~14s of wasted DB
    # round trips each round). Cool those down much longer, then let a later
    # round try once more in case the cause was transient.
    _FAILED_TTL_SECONDS = 1800.0
    # Hard cap so a pathological drop rate cannot grow the map without bound.
    _DONE_MEMORY = 5000

    def __init__(
        self,
        logger: RunLogger,
        dry_run: bool,
        *,
        workers: int = WATCH_WORKERS,
        stable_samples: int = STABLE_SAMPLES,
        stable_poll_seconds: float = STABLE_POLL_SECONDS,
        max_attempts: int = MAX_FILE_ATTEMPTS,
        backoff: Callable[[int], float] | None = None,
    ):
        self.logger = logger
        self.dry_run = dry_run
        self.workers = max(1, workers)
        self.stable_samples = stable_samples
        self.stable_poll_seconds = stable_poll_seconds
        self.max_attempts = max(1, max_attempts)
        # Seconds to wait before retry N (injectable so tests stay fast).
        self.backoff = backoff or (lambda attempt: 5.0 * attempt)

        self._queue: queue.Queue[_PendingFile | None] = queue.Queue()
        self._lock = threading.Lock()
        self._queued: set[str] = set()   # in flight or waiting
        # path -> (finish time, cooldown). Success/skip means the file was
        # archived, so the cooldown only has to outlive the duplicate FSEvents
        # of that drop; failures leave the file in place and cool down longer.
        self._done: dict[str, tuple[float, float]] = {}
        self._stats = {"success": 0, "skipped": 0, "failed": 0}
        # Per-batch tallies so a sweep / rescan round can report just its own
        # files — the global counters are cumulative for the daemon's lifetime.
        self._batch_stats: dict[str, dict[str, int]] = {}
        self._threads: list[threading.Thread] = []
        self._stopped = threading.Event()
        self._started = False

    # ── producer side ────────────────────────────────────────────────────────

    def submit(self, file_path: Path, project_name: str, batch: str | None = None) -> bool:
        """Enqueue a file for processing. Returns False when it is a duplicate."""
        key = str(file_path)
        now = time.time()
        with self._lock:
            remembered = self._done.get(key)
            if remembered is not None and now - remembered[0] < remembered[1]:
                return False
            if key in self._queued:
                return False
            self._queued.add(key)
            if batch is not None:
                self._batch_stats.setdefault(batch, {"success": 0, "skipped": 0, "failed": 0})
        self._queue.put(_PendingFile(file_path, project_name, batch=batch))
        return True

    # ── worker side ──────────────────────────────────────────────────────────

    def _finish(self, key: str, ttl: float | None = None) -> None:
        """Mark ``key`` handled, suppressing requeues for ``ttl`` seconds."""
        now = time.time()
        cooldown = self._DEDUP_TTL_SECONDS if ttl is None else ttl
        with self._lock:
            self._queued.discard(key)
            self._done[key] = (now, cooldown)
            if len(self._done) > self._DONE_MEMORY:
                expired = [
                    k for k, (at, cooldown_) in self._done.items() if now - at >= cooldown_
                ]
                for stale in expired:
                    del self._done[stale]
                # Still over the cap means everything is fresh (a burst of
                # arrivals); evict the oldest so the map stays bounded.
                overflow = len(self._done) - self._DONE_MEMORY
                if overflow > 0:
                    oldest = sorted(self._done, key=lambda k: self._done[k][0])
                    for stale in oldest[:overflow]:
                        del self._done[stale]

    def _tally(self, result: ProcessResult, batch: str | None = None) -> None:
        if result.skipped:
            key = "skipped"
        elif result.success:
            key = "success"
        else:
            key = "failed"
        with self._lock:
            self._stats[key] += 1
            # Only tally into a batch that is still registered. A round that hit
            # its drain timeout has already been reported (and popped), so late
            # results must not resurrect the entry and leak it forever.
            if batch is not None and batch in self._batch_stats:
                self._batch_stats[batch][key] += 1

    def _requeue(self, item: _PendingFile, delay: float) -> None:
        """Retry after ``delay`` without blocking this worker's queue slot."""
        if self._stopped.wait(delay):
            self._finish(str(item.path))
            return
        self._queue.put(item)

    def _handle(self, item: _PendingFile) -> None:
        file_path, project_name = item.path, item.project_name
        key = str(file_path)

        if not wait_for_stable(
            file_path,
            samples=self.stable_samples,
            poll_seconds=self.stable_poll_seconds,
        ):
            # Already archived (or deleted) by the startup sweep / rescan.
            self._finish(key)
            return

        try:
            result = _process_one(self.logger, file_path, project_name, self.dry_run)
        except DbUnavailable as exc:
            # Back off up to a minute; the rescan is the final backstop.
            delay = min(60.0, self.backoff(item.db_attempt))
            self.logger.warning(f"  [watchdog] {exc}，{delay:.0f}s 后重试")
            self._requeue(
                replace(item, db_attempt=item.db_attempt + 1), delay
            )
            return
        except Exception as exc:  # noqa: BLE001 - one bad file must not kill the worker
            # 异常也是一个失败的文件，不是「什么都没发生」：必须计数（否则本轮
            # 汇总少报失败），并按终态失败冷却——短冷却会让补扫每轮在同一坏
            # 文件上白烧一次 DB 往返。
            self.logger.error(f"  [watchdog] 处理文件异常: {file_path.name}  {exc}")
            self._tally(
                ProcessResult(skipped=False, success=False, error=str(exc)),
                item.batch,
            )
            self._finish(key, self._FAILED_TTL_SECONDS)
            return

        # 两类「还没处理完」都要重试：内容未写完会读成「未匹配任何报表类型」；
        # 入库失败（skipped=False, success=False）同样是可重试的失败，不能第一
        # 次就记 FAIL + 长冷却——那与类注释的「有界重试」自相矛盾。
        unrecognised = result.skipped and "未匹配任何报表类型" in (result.reason or "")
        ingest_failed = not result.success and not result.skipped
        retryable = unrecognised or ingest_failed
        if retryable and item.attempt < self.max_attempts:
            delay = self.backoff(item.attempt)
            reason = "未识别" if unrecognised else f"入库失败（{result.error or result.reason}）"
            self.logger.info(
                f"  [watchdog] 第 {item.attempt} 次{reason}，"
                f"{delay:.0f} 秒后重试: {file_path.name}"
            )
            self._requeue(replace(item, attempt=item.attempt + 1), delay)
            return

        self._tally(result, item.batch)
        # 重试用尽仍未识别 / 入库失败：文件留在原地，用长冷却防止补扫每轮
        # 重新白烧一轮 DB 往返；冷却到期后仍可再试一次。
        self._finish(key, self._FAILED_TTL_SECONDS if retryable else None)

    def _worker(self) -> None:
        while not self._stopped.is_set():
            try:
                item = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                if item is None:  # shutdown sentinel
                    return
                self._handle(item)
            finally:
                self._queue.task_done()

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the worker threads. Idempotent — safe to call from several places."""
        if self._started:
            return
        self._started = True
        self._stopped.clear()
        for index in range(self.workers):
            thread = threading.Thread(
                target=self._worker, daemon=True, name=f"autorun-worker-{index + 1}"
            )
            thread.start()
            self._threads.append(thread)

    def stop(self, timeout: float = 5.0) -> None:
        if not self._started:
            return
        self._stopped.set()
        for _ in self._threads:
            self._queue.put(None)
        for thread in self._threads:
            thread.join(timeout=timeout)
        self._threads.clear()
        self._started = False
        # Workers leave as soon as they observe the stop flag, so some sentinels
        # (and any still-queued files) can be left behind. Drain them — otherwise
        # a later start() would hand the stale sentinels to fresh workers and
        # they would exit immediately.
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
            else:
                self._queue.task_done()
        with self._lock:
            self._queued.clear()

    def queue_depth(self) -> int:
        return self._queue.qsize()

    def pending_count(self) -> int:
        """Files queued or currently being processed."""
        return len(self._queued)

    def wait_until_idle(
        self, poll_seconds: float = 0.5, timeout: float | None = None
    ) -> bool:
        """Block until every queued file has been processed (or given up).

        Returns False if ``timeout`` elapsed first — reachable when the DB stays
        unreachable, since those items are re-queued rather than dropped. The
        caller should not treat that as "everything failed"; the workers keep
        draining in the background.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        while not self._stopped.is_set():
            if self.pending_count() == 0 and self._queue.qsize() == 0:
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(poll_seconds)
        return False

    def snapshot_stats(self) -> dict:
        with self._lock:
            return dict(self._stats)

    def take_batch_stats(self, batch: str) -> dict:
        """Consume the tallies accumulated for ``batch`` (removes the entry)."""
        with self._lock:
            return self._batch_stats.pop(batch, {"success": 0, "skipped": 0, "failed": 0})


def collect_all_files() -> list[tuple[Path, str]]:
    """(file, project) pairs for every unprocessed file across PROJECTS."""
    found: list[tuple[Path, str]] = []
    for project_name in PROJECTS:
        project_dir = WATCH_ROOT / project_name
        if not project_dir.exists():
            continue
        found.extend((path, project_name) for path in _collect_files(project_dir))
    return found


def sweep_to_dispatcher(logger: RunLogger, dispatcher: WatchdogDispatcher) -> dict:
    """Enqueue the full backlog and block until the pool has drained it.

    This is the parallel replacement for the serial startup ``run_cycle``: the
    2026-10-16 sweep took 21.6 min for 91 files purely because files went
    through one at a time. Returns the same summary keys callers already log.

    Gated on the same cheap health probe as the rescan: with the database
    unreachable every file would burn its full retry budget (~36s) before being
    re-queued, so a 900s startup stall would buy nothing. Skipping is safe —
    files stay on disk and the rescan picks them up once the connection is back.
    """
    empty = {"projects": 0, "files_seen": 0, "success": 0, "skipped": 0, "failed": 0}
    if not check_db_health():
        logger.warning("[扫描] 数据库健康检查失败，本轮整轮跳过（不逐文件重试）")
        return empty

    pending = collect_all_files()
    batch = f"sweep-{time.time()}"
    queued = [
        (file_path, project_name)
        for file_path, project_name in pending
        if dispatcher.submit(file_path, project_name, batch=batch)
    ]
    logger.info(
        f"全盘扫描入队: {len(queued)} 文件，"
        f"{dispatcher.workers} 线程并行处理中..."
    )
    dispatcher.start()  # idempotent: already running when the observer set it up
    drained = dispatcher.wait_until_idle(timeout=DRAIN_TIMEOUT_SECONDS)
    if not drained:
        logger.warning(
            f"全盘扫描等待 {DRAIN_TIMEOUT_SECONDS:.0f}s 仍未排空（DB 可能不可用），"
            "剩余文件由 worker 与增量补扫继续处理"
        )
    stats = dispatcher.take_batch_stats(batch)
    return {
        "projects": len({name for _, name in queued}),
        "files_seen": len(queued),
        "success": stats["success"],
        "skipped": stats["skipped"],
        "failed": stats["failed"],
    }


@dataclass
class WatchdogRuntime:
    """The running watchdog: the filesystem observer plus its worker pool."""

    observer: object
    dispatcher: WatchdogDispatcher

    def stop(self) -> None:
        self.dispatcher.stop()
        self.observer.stop()

    def sweep(self, logger: RunLogger) -> dict:
        return sweep_to_dispatcher(logger, self.dispatcher)

    def join(self, timeout: float | None = None) -> None:
        self.observer.join(timeout)


def _start_watchdog_logger(
    logger: RunLogger,
    dry_run: bool,
    dispatcher: WatchdogDispatcher | None = None,
) -> WatchdogRuntime:
    """启动 watchdog 事件监控：事件只入队，由 worker 池并行处理。"""
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler

    dispatcher = dispatcher or WatchdogDispatcher(logger, dry_run)
    dispatcher.start()

    class ReportFileHandler(FileSystemEventHandler):
        _DEBOUNCE_SECONDS = 2.0

        def __init__(self):
            self._pending: dict[str, float] = {}  # debounce: 忽略 2 秒内重复事件

        def _enqueue(self, raw_path: str) -> None:
            file_path = Path(raw_path)
            if file_path.suffix.lower() not in SUPPORTED_EXTENSIONS:
                return
            # The startup sweep / rescan may have processed (and moved) the file
            # before this event landed — nothing left to do.
            if not file_path.exists():
                return

            key = str(file_path)
            now = time.time()
            if key in self._pending and now - self._pending[key] < self._DEBOUNCE_SECONDS:
                return
            if len(self._pending) > 1000:  # bounded: drop stale debounce entries
                cutoff = now - self._DEBOUNCE_SECONDS
                self._pending = {k: t for k, t in self._pending.items() if t >= cutoff}
            self._pending[key] = now

            project_name = _eligible_project_name(file_path)
            if project_name is None:
                return
            if not dispatcher.submit(file_path, project_name):
                return
            logger.info(f"  [watchdog] 已入队: {project_name}/{file_path.name}")

        def on_created(self, event):
            if event.is_directory:
                return
            self._enqueue(event.src_path)

        def on_moved(self, event):
            # RPA 常见落盘方式：先写临时文件再改名到位，此时只有 moved 事件
            # （src 是临时名、dest 才是报表）。以前只监听 created，这类文件
            # 全靠补扫，实时性差一整个间隔。
            if event.is_directory:
                return
            self._enqueue(event.dest_path)

    handler = ReportFileHandler()
    observer = Observer()
    for project_name in PROJECTS:
        project_dir = WATCH_ROOT / project_name
        if project_dir.exists():
            observer.schedule(handler, str(project_dir), recursive=False)
            # Country site subfolders (e.g. 美国) are watched too — files dropped
            # there belong to the same project.
            for sub in COUNTRY_SUBFOLDERS:
                sub_dir = project_dir / sub
                if sub_dir.exists():
                    observer.schedule(handler, str(sub_dir), recursive=False)
    observer.start()
    logger.info(
        f"watchdog 监控已启动（{dispatcher.workers} 个处理线程），监控目录: {WATCH_ROOT}"
    )
    return WatchdogRuntime(observer=observer, dispatcher=dispatcher)


def _acquire_instance_lock(logger: RunLogger) -> SingleInstanceLock | None:
    """Take the single-instance lock, or report the current holder and return None."""
    lock = SingleInstanceLock(Path(__file__).parent / "logs" / "autorun.lock")
    if lock.acquire():
        return lock
    pid = lock.holder_pid()
    logger.error(
        "已有 autoReportUpload 实例在运行"
        + (f"（PID {pid}）" if pid else "")
        + "，本进程退出。并跑两个实例会争抢同一批 RPA 文件并在 DB 上撞唯一键。"
    )
    return None


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

    lock = _acquire_instance_lock(logger)
    if lock is None:
        return

    logger.info("=" * 60)
    logger.info("autoReportUpload 服务启动")
    logger.info(f"监控目录: {WATCH_ROOT}")
    logger.info(f"项目列表: {', '.join(PROJECTS)}")
    logger.info(f"检查间隔: {CHECK_INTERVAL_MINUTES} 分钟  dry_run: {dry_run}")
    logger.info(f"单实例锁: {lock.path}")
    logger.info("=" * 60)

    if mode == "watchdog":
        logger.info("监控模式: watchdog（文件事件触发）")
        # ── 先起 watchdog，再用同一 worker 池并行跑全盘扫描 ─────────────────
        # 顺序很关键：以前是先扫描（21 分钟）再监听，这段时间落下的文件无人
        # 接收，只能等下次重启。现在监听先就位，扫描期间的新文件走事件通道，
        # 与扫描重复的由 dispatcher 的去重集合自然合并。
        runtime = _start_watchdog_logger(logger, dry_run)
        # ── 后台增量补扫：兜住漏掉的文件系统事件 ────────────────────────────
        # 先起补扫线程：全盘扫描可能跑满 DRAIN_TIMEOUT，期间补扫仍按间隔兜底。
        rescan = IncrementalRescanThread(
            logger,
            dry_run,
            interval_secs=CHECK_INTERVAL_MINUTES * 60,
            dispatcher=runtime.dispatcher,
        )
        rescan.start()
        logger.info(
            f"增量补扫已启动，每 {CHECK_INTERVAL_MINUTES} 分钟兜底扫描一次"
            f"（{runtime.dispatcher.workers} 线程并行；DB 不健康时整轮跳过）"
        )
        logger.info("watchdog 监控已启动，开始全盘扫描补齐历史积压...")
        stats = runtime.sweep(logger)
        logger.info(
            f"全盘扫描完成: {stats['files_seen']} 文件, "
            f"{stats['success']} 成功, {stats['skipped']} 跳过, {stats['failed']} 失败"
        )
        try:
            while True:
                time.sleep(5)
        except KeyboardInterrupt:
            rescan.stop()
            runtime.stop()
        runtime.join()
    else:
        logger.info(f"监控模式: polling（每 {CHECK_INTERVAL_MINUTES} 分钟轮询）")
        _main_loop_polling(logger, dry_run)

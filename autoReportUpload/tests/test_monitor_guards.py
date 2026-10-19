"""Watchdog safety-net behaviour for autoReportUpload/monitor.py.

Covers the three guards added after the 2026-10-12/10-16 incidents:

1. ``SingleInstanceLock`` — two live daemons raced on the same RPA folders and
   produced 206 FAIL rows plus 43 ``Errno 2`` file-stealing errors.
2. ``main_loop`` ordering — watchdog used to start *after* the 21-minute startup
   sweep, so files dropped during the sweep were invisible until a restart.
3. ``IncrementalRescanThread`` — dropped events used to wait for a manual
   restart (2.5h on 2026-10-16); the rescan now retries every interval and
   skips the whole round when ``check_db_health`` fails.

The rescan feeds the shared :class:`~monitor.WatchdogDispatcher`, whose own
behaviour (3 workers, stability gate, dedup, bounded retry) lives in
``tests/test_watchdog_dispatcher.py``.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from monitor import IncrementalRescanThread, SingleInstanceLock, main_loop

# ─── SingleInstanceLock ───────────────────────────────────────────────────────


class TestSingleInstanceLock:
    def test_acquire_succeeds_and_writes_pid(self, tmp_path: Path):
        lock = SingleInstanceLock(tmp_path / "autorun.lock")
        assert lock.acquire() is True
        try:
            pid = lock.holder_pid()
            assert pid and pid.isdigit()
            assert pid == lock.path.read_text(encoding="utf-8").strip()
        finally:
            lock.release()

    def test_second_acquire_fails_while_first_held(self, tmp_path: Path):
        path = tmp_path / "autorun.lock"
        first = SingleInstanceLock(path)
        second = SingleInstanceLock(path)
        assert first.acquire() is True
        try:
            assert second.acquire() is False
            assert second.holder_pid()  # holder PID is still readable
        finally:
            first.release()

    def test_second_acquire_succeeds_after_release(self, tmp_path: Path):
        path = tmp_path / "autorun.lock"
        first = SingleInstanceLock(path)
        assert first.acquire() is True
        first.release()
        second = SingleInstanceLock(path)
        assert second.acquire() is True
        second.release()

    def test_release_without_acquire_is_noop(self, tmp_path: Path):
        SingleInstanceLock(tmp_path / "autorun.lock").release()

    def test_creates_missing_parent_dir(self, tmp_path: Path):
        lock = SingleInstanceLock(tmp_path / "nested" / "logs" / "autorun.lock")
        assert lock.acquire() is True
        lock.release()


# ─── main_loop: lock gate + watchdog-before-sweep ordering ────────────────────


class TestMainLoopGuards:
    @patch("monitor.RunLogger")
    @patch("monitor.run_cycle")
    @patch("monitor._start_watchdog_logger")
    @patch("monitor._acquire_instance_lock")
    def test_exits_early_when_lock_is_held(
        self, mock_lock, mock_watchdog, mock_run_cycle, _mock_logger
    ):
        """抢不到锁时必须直接返回，不扫描、不起 watchdog。"""
        mock_lock.return_value = None
        main_loop(dry_run=False, mode="watchdog")
        mock_watchdog.assert_not_called()
        mock_run_cycle.assert_not_called()

    @patch("monitor.RunLogger")
    @patch("time.sleep", side_effect=KeyboardInterrupt)
    @patch("monitor.IncrementalRescanThread")
    @patch("monitor._start_watchdog_logger")
    @patch("monitor._acquire_instance_lock")
    def test_watchdog_starts_before_startup_sweep(
        self,
        mock_lock,
        mock_watchdog,
        _mock_rescan,
        _mock_sleep,
        _mock_logger,
        tmp_path: Path,
    ):
        """observer 必须早于全盘扫描就位，消除监听空窗。"""
        calls: list[str] = []
        lock = SingleInstanceLock(tmp_path / "autorun.lock")
        assert lock.acquire() is True
        mock_lock.return_value = lock
        runtime = MagicMock()
        runtime.sweep.side_effect = lambda *a, **k: (
            calls.append("sweep"),
            {"files_seen": 0, "success": 0, "skipped": 0, "failed": 0, "projects": 0},
        )[1]
        mock_watchdog.side_effect = lambda *a, **k: (calls.append("watchdog"), runtime)[1]

        main_loop(dry_run=False, mode="watchdog")

        assert calls[:2] == ["watchdog", "sweep"]
        # The rescan thread must exist before the (potentially long) sweep.
        _mock_rescan.return_value.start.assert_called_once()
        assert mock_watchdog.call_count == 1
        runtime.sweep.assert_called_once()
        runtime.stop.assert_called_once()
        lock.release()


# ─── IncrementalRescanThread ──────────────────────────────────────────────────


class TestIncrementalRescanThread:
    @patch("monitor.run_cycle")
    @patch("monitor.collect_all_files")
    @patch("monitor.check_db_health", return_value=True)
    def test_run_once_queues_backlog_when_db_healthy(
        self, _health, mock_collect, mock_run_cycle
    ):
        mock_collect.return_value = [
            (Path("/rpa/项目/a.txt"), "项目"),
            (Path("/rpa/项目/b.txt"), "项目"),
        ]
        dispatcher = MagicMock()
        dispatcher.submit.return_value = True
        dispatcher.take_batch_stats.return_value = {
            "success": 2, "skipped": 0, "failed": 0,
        }
        rescan = IncrementalRescanThread(
            MagicMock(), dry_run=False, interval_secs=999, dispatcher=dispatcher
        )
        stats = rescan.run_once()
        assert stats["files_seen"] == 2
        assert stats["success"] == 2
        assert dispatcher.submit.call_count == 2
        dispatcher.wait_until_idle.assert_called_once()
        mock_run_cycle.assert_not_called()

    @patch("monitor.collect_all_files")
    @patch("monitor.check_db_health", return_value=False)
    def test_run_once_skips_whole_round_when_db_unhealthy(
        self, _health, mock_collect
    ):
        """DB 不健康时整轮跳过——不逐文件重试（否则每文件白烧 ~44s）。"""
        logger = MagicMock()
        rescan = IncrementalRescanThread(
            logger, dry_run=False, interval_secs=999, dispatcher=MagicMock()
        )
        assert rescan.run_once() is None
        mock_collect.assert_not_called()
        assert "整轮跳过" in logger.warning.call_args[0][0]

    def test_stop_releases_wait_immediately(self):
        rescan = IncrementalRescanThread(
            MagicMock(), dry_run=False, interval_secs=3600, dispatcher=MagicMock()
        )
        rescan.start()
        rescan.stop()
        rescan.join(timeout=2)
        assert not rescan.is_alive()

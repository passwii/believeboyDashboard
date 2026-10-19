"""Parallel watchdog processing (monitor.WatchdogDispatcher + helpers).

The 2026-10-16 startup sweep took 21.6 minutes for 91 files because every file
went through one inline path — and the cost sits in cross-network DB round
trips (~14s median per file, independent of file size), so throughput is
concurrency-bound. These tests cover the replacement:

- ``wait_for_stable``: macOS FSEvents has no ``on_closed``, so "file finished
  being written" must be inferred from size + mtime samples.
- ``WatchdogDispatcher``: N workers really run in parallel, a path is never
  queued twice, and incomplete files get a bounded number of retries instead of
  being silently dropped.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

from monitor import (
    DbUnavailable,
    WatchdogDispatcher,
    _eligible_project_name,
    collect_all_files,
    sweep_to_dispatcher,
    wait_for_stable,
)
from processor import ProcessResult


def _result(*, skipped: bool, success: bool, reason: str = "") -> ProcessResult:
    return ProcessResult(skipped=skipped, success=success, reason=reason)


# ─── wait_for_stable ──────────────────────────────────────────────────────────


class TestWaitForStable:
    def test_returns_true_once_fingerprint_stops_changing(self):
        prints = iter([(10, 1), (10, 1), (10, 1)])
        sleeps: list[float] = []
        assert wait_for_stable(
            Path("/rpa/项目/a.txt"),
            samples=3,
            poll_seconds=0.5,
            fingerprint=lambda _p: next(prints, (10, 1)),
            sleep=sleeps.append,
        ) is True
        assert sleeps == [0.5, 0.5]

    def test_keeps_waiting_while_file_is_still_growing(self):
        """RPA 落盘会先出现再增长：指纹变化期间不得判定稳定。"""
        prints = iter([(10, 1), (20, 2), (30, 3), (30, 3)])
        assert wait_for_stable(
            Path("/rpa/项目/a.txt"),
            samples=2,
            fingerprint=lambda _p: next(prints, (30, 3)),
            sleep=lambda _s: None,
        ) is True

    def test_returns_false_when_file_vanished(self):
        """已被扫描/补扫移走的文件无需处理。"""
        assert wait_for_stable(
            Path("/rpa/项目/a.txt"),
            samples=2,
            fingerprint=lambda _p: None,
            sleep=lambda _s: None,
        ) is False

    def test_returns_false_when_file_disappears_mid_wait(self):
        prints = iter([(10, 1), None])
        assert wait_for_stable(
            Path("/rpa/项目/a.txt"),
            samples=2,
            fingerprint=lambda _p: next(prints, None),
            sleep=lambda _s: None,
        ) is False

    def test_single_sample_returns_immediately(self):
        sleeps: list[float] = []
        assert wait_for_stable(
            Path("/rpa/项目/a.txt"),
            samples=1,
            fingerprint=lambda _p: (1, 1),
            sleep=sleeps.append,
        ) is True
        assert sleeps == []


# ─── _eligible_project_name ───────────────────────────────────────────────────


class TestEligibleProjectName:
    @patch("monitor.PROJECTS", ["项目甲"])
    @patch("monitor.WATCH_ROOT", Path("/rpa"))
    def test_project_root_file_is_eligible(self):
        assert _eligible_project_name(Path("/rpa/项目甲/a.txt")) == "项目甲"

    @patch("monitor.PROJECTS", ["项目甲"])
    @patch("monitor.WATCH_ROOT", Path("/rpa"))
    def test_country_subfolder_resolves_to_project(self):
        assert _eligible_project_name(Path("/rpa/项目甲/美国/a.txt")) == "项目甲"

    @patch("monitor.PROJECTS", ["项目甲"])
    @patch("monitor.WATCH_ROOT", Path("/rpa"))
    def test_processed_folder_is_rejected(self):
        assert _eligible_project_name(Path("/rpa/项目甲/processed/a.txt")) is None

    @patch("monitor.PROJECTS", ["项目甲"])
    @patch("monitor.WATCH_ROOT", Path("/rpa"))
    def test_ad_processed_folder_is_rejected(self):
        assert _eligible_project_name(Path("/rpa/项目甲/广告Processed/a.txt")) is None

    @patch("monitor.PROJECTS", ["项目甲"])
    @patch("monitor.WATCH_ROOT", Path("/rpa"))
    def test_unknown_project_is_rejected(self):
        assert _eligible_project_name(Path("/rpa/项目乙/a.txt")) is None


# ─── dedup + workers ──────────────────────────────────────────────────────────


class TestDispatcherDedup:
    def test_same_path_is_only_queued_once(self):
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        path = Path("/rpa/项目/a.txt")
        assert dispatcher.submit(path, "项目") is True
        assert dispatcher.submit(path, "项目") is False
        assert dispatcher.pending_count() == 1

    def test_recently_finished_path_is_not_requeued(self):
        """刚落盘处理完的文件会被重复的 FSEvents 再次报告，必须抑制。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        path = Path("/rpa/项目/a.txt")
        dispatcher.submit(path, "项目")
        dispatcher._finish(str(path))
        assert dispatcher.submit(path, "项目") is False

    def test_path_can_be_resubmitted_once_cooldown_expires(self):
        """扣完冷却后同一路径应可重新入队——否则补扫永远捞不到它。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        path = Path("/rpa/项目/a.txt")
        dispatcher.submit(path, "项目")
        dispatcher._finish(str(path))
        with patch("monitor.time.time", return_value=time.time() + 601):
            assert dispatcher.submit(path, "项目") is True

    def test_failed_file_cools_down_longer_than_a_success(self):
        """失败文件留在原地，冷却必须比成功长，避免补扫每轮白烧。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        failed = Path("/rpa/项目/bad.txt")
        dispatcher.submit(failed, "项目")
        dispatcher._finish(str(failed), dispatcher._FAILED_TTL_SECONDS)
        # Still suppressed well past the normal dedup window.
        with patch("monitor.time.time", return_value=time.time() + 1200):
            assert dispatcher.submit(failed, "项目") is False
        with patch("monitor.time.time", return_value=time.time() + 1801):
            assert dispatcher.submit(failed, "项目") is True

    def test_done_memory_is_bounded(self):
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        dispatcher._DONE_MEMORY = 3
        # Freeze time so every entry is "fresh" and nothing can expire out —
        # the cap itself must do the bounding.
        frozen = time.time()
        for i in range(10):
            with patch("monitor.time.time", return_value=frozen):
                dispatcher.submit(Path(f"/rpa/项目/f{i}.txt"), "项目")
                dispatcher._finish(f"/rpa/项目/f{i}.txt")
        assert len(dispatcher._done) == 3


class TestDispatcherConcurrency:
    def test_three_workers_process_files_in_parallel(self, tmp_path: Path):
        """3 个 worker 必须真正并行——串行时 barrier 会超时。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=3)
        barrier = threading.Barrier(3, timeout=10)
        seen: list[str] = []
        lock = threading.Lock()

        def fake_process(logger, file_path, project_name, dry_run):
            with lock:
                seen.append(file_path.name)
            barrier.wait()  # all three must be in flight at the same time
            return _result(skipped=False, success=True)

        files = [(tmp_path / f"f{i}.txt", "项目") for i in range(3)]
        for path, _project in files:
            path.write_text("data", encoding="utf-8")

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                for path, project in files:
                    assert dispatcher.submit(path, project) is True
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert sorted(seen) == ["f0.txt", "f1.txt", "f2.txt"]
        assert dispatcher.snapshot_stats()["success"] == 3

    def test_worker_count_is_never_below_one(self):
        assert WatchdogDispatcher(MagicMock(), dry_run=True, workers=0).workers == 1
        assert WatchdogDispatcher(MagicMock(), dry_run=True, workers=3).workers == 3


# ─── retry / failure handling ─────────────────────────────────────────────────


def _fast_backoff(_attempt: int) -> float:
    """Retries are bounded by attempt count, not by wall-clock — keep tests quick."""
    return 0.0


class TestDispatcherRetry:
    def test_unrecognised_file_is_retried_up_to_max_attempts(self, tmp_path: Path):
        """未识别 → 有界重试，最终记 FAIL，不再静默丢弃。"""
        dispatcher = WatchdogDispatcher(
            MagicMock(), dry_run=True, workers=1, max_attempts=3, backoff=_fast_backoff
        )
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        calls: list[int] = []

        def fake_process(logger, file_path, project_name, dry_run):
            calls.append(1)
            return _result(skipped=True, success=False, reason="未匹配任何报表类型")

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert len(calls) == 3
        # After the final failure the path is terminal (not left pending forever).
        assert dispatcher.pending_count() == 0
        assert str(path) in dispatcher._done

    def test_max_attempts_of_one_does_not_retry(self, tmp_path: Path):
        dispatcher = WatchdogDispatcher(
            MagicMock(), dry_run=True, workers=1, max_attempts=1, backoff=_fast_backoff
        )
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        calls: list[int] = []

        def fake_process(logger, file_path, project_name, dry_run):
            calls.append(1)
            return _result(skipped=True, success=False, reason="未匹配任何报表类型")

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert len(calls) == 1

    def test_db_unavailable_retries_without_consuming_file_attempts(
        self, tmp_path: Path
    ):
        """DB 断开属于环境问题，不该耗掉文件的重试预算。"""
        logger = MagicMock()
        dispatcher = WatchdogDispatcher(
            logger, dry_run=False, workers=1, max_attempts=1, backoff=_fast_backoff
        )
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        attempts: list[int] = []
        recovered = threading.Event()

        def fake_process(logger_, file_path, project_name, dry_run):
            attempts.append(1)
            if len(attempts) < 3:
                raise DbUnavailable("无法获取数据库连接")
            recovered.set()
            return _result(skipped=False, success=True)

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                assert recovered.wait(timeout=20), "DB 恢复后应完成处理"
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert len(attempts) == 3
        assert dispatcher.snapshot_stats()["success"] == 1
        assert any("重试" in str(c.args[0]) for c in logger.warning.call_args_list)

    def test_unexpected_exception_marks_file_terminal(self, tmp_path: Path):
        """单个坏文件抛异常不得让 worker 卡死或反复重试。"""
        logger = MagicMock()
        dispatcher = WatchdogDispatcher(logger, dry_run=True, workers=1)
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        calls: list[int] = []

        def fake_process(logger_, file_path, project_name, dry_run):
            calls.append(1)
            raise ValueError("boom")

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert len(calls) == 1
        assert dispatcher.pending_count() == 0
        assert str(path) in dispatcher._done

    def test_unexpected_exception_is_counted_and_cools_down_terminally(
        self, tmp_path: Path
    ):
        """抛异常也是一次失败：必须计入本轮 failed，并用终态失败冷却。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")

        def fake_process(logger_, file_path, project_name, dry_run):
            raise ValueError("boom")

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目", batch="round-1")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert dispatcher.snapshot_stats() == {"success": 0, "skipped": 0, "failed": 1}
        assert dispatcher.take_batch_stats("round-1")["failed"] == 1
        # 终态失败（长冷却），不是成功后的短冷却。
        _at, cooldown = dispatcher._done[str(path)]
        assert cooldown == dispatcher._FAILED_TTL_SECONDS

    def test_ingest_failure_is_retried_up_to_max_attempts(self, tmp_path: Path):
        """入库失败（skipped=False, success=False）是有界重试对象，不是一次性终态。"""
        dispatcher = WatchdogDispatcher(
            MagicMock(), dry_run=True, workers=1, max_attempts=3, backoff=_fast_backoff
        )
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        calls: list[int] = []

        def fake_process(logger_, file_path, project_name, dry_run):
            calls.append(1)
            return _result(skipped=False, success=False, reason="入库失败")

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert len(calls) == 3, "入库失败应重试满 max_attempts 次"
        # 只记一次 FAIL（不是每次重试都记），且按终态失败冷却。
        assert dispatcher.snapshot_stats() == {"success": 0, "skipped": 0, "failed": 1}
        _at, cooldown = dispatcher._done[str(path)]
        assert cooldown == dispatcher._FAILED_TTL_SECONDS

    def test_ingest_failure_that_recovers_is_reported_as_success(
        self, tmp_path: Path
    ):
        """重试窗口内的入库失败可以恢复，恢复后不得再报失败。"""
        dispatcher = WatchdogDispatcher(
            MagicMock(), dry_run=True, workers=1, max_attempts=3, backoff=_fast_backoff
        )
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        calls: list[int] = []

        def fake_process(logger_, file_path, project_name, dry_run):
            calls.append(1)
            if len(calls) < 2:
                return _result(skipped=False, success=False, reason="入库失败")
            return _result(skipped=False, success=True)

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert len(calls) == 2
        assert dispatcher.snapshot_stats() == {"success": 1, "skipped": 0, "failed": 0}

    def test_db_retry_backoff_grows_with_consecutive_outages(self, tmp_path: Path):
        """连续 DB 断线必须逐次加大退避，而不是永远停在同一个档位。"""
        delays: list[float] = []

        def backoff(attempt: int) -> float:
            delays.append(5.0 * attempt)
            return 0.0  # keep the test fast; the *value* is what we assert on

        dispatcher = WatchdogDispatcher(
            MagicMock(), dry_run=False, workers=1, backoff=backoff
        )
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")
        attempts: list[int] = []

        def fake_process(*_a, **_k):
            attempts.append(1)
            if len(attempts) <= 3:
                raise DbUnavailable("无法获取数据库连接")
            return _result(skipped=False, success=True)

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=fake_process
        ):
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert delays == [5.0, 10.0, 15.0]
        assert dispatcher.snapshot_stats()["success"] == 1

    def test_vanished_file_is_not_processed(self, tmp_path: Path):
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        path = tmp_path / "a.txt"
        path.write_text("data", encoding="utf-8")

        with patch("monitor.wait_for_stable", return_value=False), patch(
            "monitor._process_one"
        ) as mock_process:
            dispatcher.start()
            try:
                dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        mock_process.assert_not_called()
        assert dispatcher.pending_count() == 0


class TestDispatcherStats:
    def test_stats_split_by_outcome(self, tmp_path: Path):
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=2)
        outcomes = iter(
            [
                _result(skipped=False, success=True),
                _result(skipped=True, success=False, reason="SHA-256 重复"),
                _result(skipped=False, success=False, reason="入库失败"),
            ]
        )
        files = []
        for i in range(3):
            path = tmp_path / f"f{i}.txt"
            path.write_text("data", encoding="utf-8")
            files.append(path)

        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one", side_effect=lambda *a, **k: next(outcomes)
        ):
            dispatcher.start()
            try:
                for path in files:
                    dispatcher.submit(path, "项目")
                dispatcher.wait_until_idle()
            finally:
                dispatcher.stop()

        assert dispatcher.snapshot_stats() == {"success": 1, "skipped": 1, "failed": 1}

    def test_stop_is_idempotent(self):
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=2)
        dispatcher.start()
        dispatcher.stop()
        dispatcher.stop()

    def test_late_result_does_not_resurrect_a_reported_batch(self):
        """排空超时后该批次已上报并弹出，迟到的结果不得把它重新建回来。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        dispatcher.submit(Path("/rpa/项目/a.txt"), "项目", batch="round-1")
        first = dispatcher.take_batch_stats("round-1")
        assert first == {"success": 0, "skipped": 0, "failed": 0}

        dispatcher._tally(_result(skipped=False, success=True), batch="round-1")

        assert "round-1" not in dispatcher._batch_stats

    def test_wait_until_idle_returns_false_on_timeout(self):
        """DB 不可用时文件反复 requeue，等待必须有上限而不是永久挂住。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        dispatcher.submit(Path("/rpa/项目/a.txt"), "项目")
        assert dispatcher.wait_until_idle(poll_seconds=0.01, timeout=0.05) is False

    def test_wait_until_idle_returns_true_when_empty(self):
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        assert dispatcher.wait_until_idle(poll_seconds=0.01, timeout=1.0) is True

    def test_restart_after_stop_leaves_no_stale_sentinels(self):
        """stop() 后队列里的哨兵必须清掉，否则重启的 worker 会立刻退出。"""
        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=1)
        dispatcher.start()
        dispatcher.stop()
        assert dispatcher.queue_depth() == 0

        path = Path("/rpa/项目/a.txt")
        dispatcher.start()
        try:
            with patch("monitor.wait_for_stable", return_value=True), patch(
                "monitor._process_one",
                side_effect=lambda *a, **k: _result(skipped=False, success=True),
            ):
                assert dispatcher.submit(path, "项目") is True
                assert dispatcher.wait_until_idle(poll_seconds=0.01, timeout=2.0)
        finally:
            dispatcher.stop()
        assert dispatcher.snapshot_stats()["success"] == 1


# ─── sweep orchestration ──────────────────────────────────────────────────────


class TestSweepToDispatcher:
    @patch("monitor.collect_all_files")
    @patch("monitor.check_db_health", return_value=True)
    def test_sweep_queues_backlog_and_reports_stats(
        self, _health, mock_collect, tmp_path: Path
    ):
        paths = []
        for i in range(4):
            path = tmp_path / f"f{i}.txt"
            path.write_text("data", encoding="utf-8")
            paths.append(path)
        mock_collect.return_value = [(p, "项目甲") for p in paths[:2]] + [
            (p, "项目乙") for p in paths[2:]
        ]

        dispatcher = WatchdogDispatcher(MagicMock(), dry_run=True, workers=2)
        logger = MagicMock()
        with patch("monitor.wait_for_stable", return_value=True), patch(
            "monitor._process_one",
            side_effect=lambda *a, **k: _result(skipped=False, success=True),
        ):
            stats = sweep_to_dispatcher(logger, dispatcher)

        assert stats["files_seen"] == 4
        assert stats["success"] == 4
        assert stats["projects"] == 2
        assert dispatcher.pending_count() == 0

    @patch("monitor._collect_files")
    @patch("monitor.PROJECTS", ["项目甲", "项目乙"])
    def test_collect_all_files_skips_missing_project_dirs(
        self, mock_collect, tmp_path: Path
    ):
        (tmp_path / "项目甲").mkdir()
        mock_collect.return_value = [tmp_path / "项目甲" / "a.txt"]
        with patch("monitor.WATCH_ROOT", tmp_path):
            found = collect_all_files()
        assert found == [(tmp_path / "项目甲" / "a.txt", "项目甲")]

    @patch("monitor.collect_all_files")
    @patch("monitor.check_db_health", return_value=False)
    def test_sweep_skips_whole_round_when_db_unhealthy(
        self, _health, mock_collect
    ):
        """启动扫描同样要有 DB 健康门——否则会先烧满 900s 再空手而归。"""
        logger = MagicMock()
        dispatcher = WatchdogDispatcher(logger, dry_run=True, workers=2)
        stats = sweep_to_dispatcher(logger, dispatcher)
        assert stats == {
            "projects": 0, "files_seen": 0,
            "success": 0, "skipped": 0, "failed": 0,
        }
        mock_collect.assert_not_called()
        assert "整轮跳过" in logger.warning.call_args[0][0]

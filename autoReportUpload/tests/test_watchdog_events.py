"""The watchdog event handler: events must only enqueue, never process inline.

Before this change ``on_created`` called ``process_file`` directly on the
watchdog thread and even slept 5s inside the handler to retry unrecognised
files. With ~14s of DB round trips per file that stalled every other arrival
(and froze the observer while it slept). The handler is now a pure producer:
cheap filtering, debounce, then hand the path to the worker pool.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from monitor import WatchdogDispatcher, _start_watchdog_logger


@pytest.fixture
def watched_env(tmp_path: Path):
    """A fake WATCH_ROOT with one in-scope project and one country subfolder."""
    (tmp_path / "项目甲" / "美国").mkdir(parents=True, exist_ok=True)
    (tmp_path / "项目乙").mkdir(parents=True, exist_ok=True)
    with patch("monitor.WATCH_ROOT", tmp_path), patch(
        "monitor.PROJECTS", ["项目甲"]
    ), patch("monitor.COUNTRY_SUBFOLDERS", frozenset({"美国"})):
        yield tmp_path


def _make_runtime(dispatcher=None):
    """Start the watchdog with a mocked observer and return (runtime, handler)."""
    dispatcher = dispatcher or MagicMock()
    dispatcher.workers = 3
    with patch("watchdog.observers.Observer") as mock_observer_cls:
        observer = mock_observer_cls.return_value
        runtime = _start_watchdog_logger(MagicMock(), dry_run=True, dispatcher=dispatcher)
    handler = observer.schedule.call_args_list[0][0][0]
    scheduled = [c[0][1] for c in observer.schedule.call_args_list]
    return runtime, handler, observer, scheduled


def _event(path: Path, *, is_directory: bool = False):
    return SimpleNamespace(is_directory=is_directory, src_path=str(path))


def _moved_event(src: Path, dest: Path, *, is_directory: bool = False):
    return SimpleNamespace(
        is_directory=is_directory, src_path=str(src), dest_path=str(dest)
    )


class TestOnCreatedEnqueues:
    def test_eligible_file_is_submitted(self, watched_env: Path):
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        path = watched_env / "项目甲" / "美国" / "报表.txt"
        path.write_text("data", encoding="utf-8")

        handler.on_created(_event(path))

        dispatcher.submit.assert_called_once_with(path, "项目甲")

    def test_handler_does_not_process_or_sleep(self, watched_env: Path):
        """handler 只入队：绝不在这里跑 process_file，也不 sleep。"""
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        path = watched_env / "项目甲" / "报表.txt"
        path.write_text("data", encoding="utf-8")

        with patch("monitor.process_file") as mock_process, patch(
            "monitor._process_one"
        ) as mock_process_one, patch("time.sleep") as mock_sleep:
            handler.on_created(_event(path))

        mock_process.assert_not_called()
        mock_process_one.assert_not_called()
        mock_sleep.assert_not_called()
        dispatcher.submit.assert_called_once()


class TestOnCreatedFiltering:
    def test_directory_events_are_ignored(self, watched_env: Path):
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        handler.on_created(_event(watched_env / "项目甲", is_directory=True))
        dispatcher.submit.assert_not_called()

    def test_unsupported_extension_is_ignored(self, watched_env: Path):
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        path = watched_env / "项目甲" / "notes.md"
        path.write_text("data", encoding="utf-8")
        handler.on_created(_event(path))
        dispatcher.submit.assert_not_called()

    def test_file_already_moved_is_ignored(self, watched_env: Path):
        """扫描/补扫可能已抢先处理并归档，事件到手时文件已不在。"""
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        missing = watched_env / "项目甲" / "已归档.txt"
        handler.on_created(_event(missing))
        dispatcher.submit.assert_not_called()

    def test_unknown_project_is_ignored(self, watched_env: Path):
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        path = watched_env / "项目乙" / "报表.txt"
        path.write_text("data", encoding="utf-8")
        handler.on_created(_event(path))
        dispatcher.submit.assert_not_called()

    def test_duplicate_event_within_debounce_is_ignored(self, watched_env: Path):
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        path = watched_env / "项目甲" / "报表.txt"
        path.write_text("data", encoding="utf-8")

        handler.on_created(_event(path))
        handler.on_created(_event(path))

        dispatcher.submit.assert_called_once_with(path, "项目甲")

    def test_debounce_map_is_pruned_when_large(self, watched_env: Path):
        """长时间运行必须有界——否则每个落过的文件都会永久留在内存里。"""
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        handler._pending = {f"old-{i}": 0.0 for i in range(1001)}
        path = watched_env / "项目甲" / "报表.txt"
        path.write_text("data", encoding="utf-8")

        handler.on_created(_event(path))

        assert len(handler._pending) < 1001


class TestObserverScheduling:
    def test_moved_into_place_file_is_submitted(self, watched_env: Path):
        """临时文件改名落盘：dest 才是真报表，必须按 dest 入队。"""
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        tmp = watched_env / "项目甲" / "报表.txt.part"
        dest = watched_env / "项目甲" / "报表.txt"
        dest.write_text("data", encoding="utf-8")

        handler.on_moved(_moved_event(tmp, dest))

        dispatcher.submit.assert_called_once_with(dest, "项目甲")

    def test_moved_directory_is_ignored(self, watched_env: Path):
        dispatcher = MagicMock()
        _runtime, handler, _observer, _scheduled = _make_runtime(dispatcher)
        handler.on_moved(
            _moved_event(
                watched_env / "项目甲" / "tmpdir",
                watched_env / "项目甲" / "报表.txt",
                is_directory=True,
            )
        )
        dispatcher.submit.assert_not_called()

    def test_schedules_project_root_and_country_subfolders(self, watched_env: Path):
        _runtime, _handler, _observer, scheduled = _make_runtime()
        assert str(watched_env / "项目甲") in scheduled
        assert str(watched_env / "项目甲" / "美国") in scheduled

    def test_stop_stops_both_observer_and_workers(self, watched_env: Path):
        dispatcher = MagicMock()
        dispatcher.workers = 3
        with patch("watchdog.observers.Observer") as mock_observer_cls:
            observer = mock_observer_cls.return_value
            runtime = _start_watchdog_logger(
                MagicMock(), dry_run=True, dispatcher=dispatcher
            )
        runtime.stop()
        observer.stop.assert_called_once()
        dispatcher.stop.assert_called_once()

    def test_real_dispatcher_is_started_and_owns_three_workers(self, watched_env: Path):
        real = WatchdogDispatcher(MagicMock(), dry_run=True, workers=3)
        with patch("watchdog.observers.Observer"):
            runtime = _start_watchdog_logger(MagicMock(), dry_run=True, dispatcher=real)
        try:
            assert len(runtime.dispatcher._threads) == 3
            assert all(t.is_alive() for t in runtime.dispatcher._threads)
        finally:
            runtime.stop()

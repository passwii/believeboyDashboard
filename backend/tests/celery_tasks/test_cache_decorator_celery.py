"""Celery 装饰器 + mark_committed 协议集成测试（BLF-665 子 #4）。

验证（设计 §7.4 tests/celery/test_cache_decorator_celery.py）：
1. commit + mark → 缓存失效被调用
2. 未 mark → log warning 但任务仍成功
3. 任务抛异常 → cache 不失效（fail-safe）

用 spy invalidate_fn + 内存 store，不依赖真实 Celery worker / Redis。
"""

from __future__ import annotations

import logging

import pytest

from app.services.infra import cache_decorator as cd


@pytest.fixture(autouse=True)
def _cleanup_domains(monkeypatch):
    saved = dict(cd._INVALIDATE_FNS)
    cd.reset_committed()
    yield
    cd.reset_committed()
    cd._INVALIDATE_FNS.clear()
    cd._INVALIDATE_FNS.update(saved)


@pytest.fixture
def spy():
    calls: list = []

    def _fn(project_id=None, **kwargs):
        calls.append(project_id)

    cd._INVALIDATE_FNS["ai_insight"] = _fn
    return calls


class TestCeleryCommitProtocol:
    def test_marked_commit_invalidates(self, spy):
        """commit + mark_committed → 装饰器在返回时失效。"""

        @cd.invalidate_cache_on_commit_celery(
            domains=["ai_insight"], project_id_from="global"
        )
        def task():
            cd.mark_committed()
            return "ok"

        result = task()
        assert result == "ok"
        assert spy == [None], "已 mark 应触发失效（project_id=None = 全量）"

    def test_unmarked_logs_warning_but_succeeds(self, spy, caplog):
        """未 mark → log warning，任务仍成功（A2）。"""

        @cd.invalidate_cache_on_commit_celery(
            domains=["ai_insight"], project_id_from="global"
        )
        def task():
            return "ok"

        with caplog.at_level(
            logging.WARNING, logger="app.services.infra.cache_decorator"
        ):
            result = task()
        assert result == "ok"
        assert spy == [], "未 mark 不得失效（A2）"
        assert "mark_committed" in caplog.text, "应 log warning 提醒漏 mark"

    def test_exception_skips_invalidation(self, spy):
        """任务抛异常 → 不失效（fail-safe，A1）。"""

        @cd.invalidate_cache_on_commit_celery(
            domains=["ai_insight"], project_id_from="global"
        )
        def task():
            cd.mark_committed()  # 即使 mark 了，异常也要跳过失效
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            task()
        assert spy == [], "异常时不得失效（A1 fail-safe）"

    def test_auto_commit_context_manager(self, spy):
        """auto_commit(db) 一体化：exit 时自动 commit + mark。"""

        class FakeDb:
            def __init__(self):
                self.committed = False

            def commit(self):
                self.committed = True

            def rollback(self):
                pass

        db = FakeDb()

        @cd.invalidate_cache_on_commit_celery(
            domains=["ai_insight"], project_id_from="global"
        )
        def task():
            with cd.auto_commit(db):
                pass
            return "ok"

        task()
        assert db.committed, "auto_commit 应自动 commit"
        assert spy == [None], "auto_commit 后应失效"

    def test_auto_commit_rollback_on_exception(self, spy):
        """auto_commit 遇异常 → rollback 且不 mark（铁律 2）。"""

        class FakeDb:
            def __init__(self):
                self.committed = False
                self.rolled_back = False

            def commit(self):
                self.committed = True

            def rollback(self):
                self.rolled_back = True

        db = FakeDb()

        @cd.invalidate_cache_on_commit_celery(
            domains=["ai_insight"], project_id_from="global"
        )
        def task():
            with pytest.raises(RuntimeError):
                with cd.auto_commit(db):
                    raise RuntimeError("inner")
            return "ok"

        result = task()
        assert result == "ok"
        assert db.rolled_back, "auto_commit 遇异常应 rollback"
        assert not db.committed, "异常时不应 commit"
        assert spy == [], "异常时不应失效"

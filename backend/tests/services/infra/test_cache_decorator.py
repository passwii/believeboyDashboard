"""A 类：已装饰失效失败场景测试（BLF-666，设计 doc §7.1）。

覆盖 8 个"装饰器在失败路径上的行为"场景:
- A1-A6: Celery 装饰器 6 个失败场景
    A1 exception 跳过（任务异常 → 不失效，异常传播）
    A2 未 mark warning（正常返回但未 mark_committed → warning，不失效）
    A3 解析失败全量（project_id 解析失败 → 回退全量失效）
    A4 域未注册 KeyError（装饰时域不在 REGISTERED_DOMAINS → KeyError）
    A5 L0 拒绝 log（L0 on_error="log" → ValueError）
    A6 resolver 异常主失效（失效函数本身抛异常 → 按 on_error 策略处理）
- A7-A8: FastAPI 装饰器 2 个场景
    A7 HTTPException 跳过（端点抛 HTTPException → 不失效）
    A8 域未注册（FastAPI 装饰器域未注册 → KeyError）
"""

from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException

import app.services.infra.cache_decorator as cd


# ── A1-A6: Celery 装饰器失败场景 ─────────────────────────────────────


class TestCeleryExceptionSkipsInvalidation:
    """A1: 任务抛异常 → 跳过失效，异常向上传播。"""

    def test_exception_propagates_and_no_invalidation(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        register, calls = spy_invalidate_fns
        register("inventory_replenishment")

        @cd.invalidate_cache_on_commit_celery(
            domains=["inventory_replenishment"], project_id_from="arg"
        )
        def task(project_id: int) -> str:
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            task(7)
        assert calls == {}, "任务异常时不应执行任何失效"


class TestCeleryNoMarkWarns:
    """A2: 正常返回但未 mark_committed() → warning，不失效。"""

    def test_unmarked_task_logs_warning_and_skips(
        self, spy_invalidate_fns, reset_committed_marker, caplog
    ):
        register, calls = spy_invalidate_fns
        register("shipment_schedules")

        @cd.invalidate_cache_on_commit_celery(
            domains=["shipment_schedules"], project_id_from="arg"
        )
        def task(project_id: int) -> str:
            return "ok"  # 未调用 mark_committed

        with caplog.at_level(logging.WARNING):
            result = task(3)
        assert result == "ok"
        assert calls == {}, "未 mark_committed 的任务不应失效缓存"
        assert any("mark_committed" in r.message for r in caplog.records)


class TestCeleryResolutionFailureFallsBackToFull:
    """A3: project_id 解析失败 → 回退全量失效（project_id=None）。"""

    def test_missing_arg_falls_back_to_full_invalidation(
        self, spy_invalidate_fns, reset_committed_marker, caplog
    ):
        register, calls = spy_invalidate_fns
        register("return_analysis")

        @cd.invalidate_cache_on_commit_celery(
            domains=["return_analysis"], project_id_from="arg"
        )
        def task() -> str:
            cd.mark_committed()
            return "ok"

        with caplog.at_level(logging.WARNING):
            result = task()
        assert result == "ok"
        # 解析失败 → project_id=None 全量失效
        assert calls["return_analysis"] == [(None, None)]
        assert any("解析失败" in r.message for r in caplog.records)


class TestCeleryUnregisteredDomainKeyError:
    """A4: 装饰时域未登记 → KeyError。"""

    def test_unregistered_domain_raises_keyerror(self, reset_committed_marker):
        with pytest.raises(KeyError, match="未登记"):

            @cd.invalidate_cache_on_commit_celery(
                domains=["no_such_domain"], project_id_from="arg"
            )
            def task(project_id: int) -> str:
                return "ok"


class TestL0RejectsLog:
    """A5: L0 拒绝 on_error="log"（强一致不允许静默吞失效）。"""

    def test_l0_decorator_rejects_log(self):
        with pytest.raises(ValueError, match="L0"):

            @cd.invalidate_cache_on_commit(
                domains=["inventory_replenishment"],
                project_id_from="path",
                on_error="log",  # type: ignore[arg-type]
            )
            def endpoint(project_id: int) -> str:
                return "ok"

    def test_l1_decorator_requires_log(self):
        """对照：L1 装饰器 on_error 强制 'log'。"""
        with pytest.raises(ValueError, match="L1"):

            @cd.invalidate_cache_on_commit_l1(
                domains=["shipment_schedules"],
                project_id_from="path",
                on_error="raise",  # type: ignore[arg-type]
            )
            def endpoint(project_id: int) -> str:
                return "ok"


class TestResolverExceptionPolicy:
    """A6: 失效函数本身抛异常 → 按 on_error 策略处理。

    - on_error="log"（L1/Celery）: 记 warning，不阻断请求；
    - on_error="raise"（L0）: 上抛（强一致可见性）。
    """

    def test_l1_resolver_error_logs_and_continues(
        self, register_test_fns, reset_committed_marker, caplog
    ):
        def boom(project_id=None, **kwargs):
            raise RuntimeError("resolver broke")

        register_test_fns("shipment_schedules", boom)

        @cd.invalidate_cache_on_commit_l1(
            domains=["shipment_schedules"], project_id_from="path"
        )
        def endpoint(project_id: int) -> str:
            return "ok"

        with caplog.at_level(logging.WARNING):
            result = endpoint(project_id=1)
        assert result == "ok", "L1 失效失败不应阻断请求"
        assert any("失效失败" in r.message for r in caplog.records)

    def test_l0_resolver_error_raises(self, register_test_fns, reset_committed_marker):
        def boom(project_id=None, **kwargs):
            raise RuntimeError("resolver broke")

        register_test_fns("inventory_replenishment", boom)

        @cd.invalidate_cache_on_commit(
            domains=["inventory_replenishment"], project_id_from="path"
        )
        def endpoint(project_id: int) -> str:
            return "ok"

        with pytest.raises(RuntimeError, match="resolver broke"):
            endpoint(project_id=1)


# ── A7-A8: FastAPI 装饰器失败场景 ────────────────────────────────────


class TestHttpExceptionSkips:
    """A7: 端点抛 HTTPException → 跳过失效（写未提交）。"""

    def test_http_exception_skips_invalidation(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        register, calls = spy_invalidate_fns
        register("platform_revenues")

        @cd.invalidate_cache_on_commit(
            domains=["platform_revenues"], project_id_from="global"
        )
        def endpoint(project_id: int) -> str:
            raise HTTPException(status_code=404, detail="not found")

        with pytest.raises(HTTPException):
            endpoint(project_id=1)
        assert calls == {}, "HTTPException 时应跳过失效"

    def test_http_exception_skips_l1(self, spy_invalidate_fns, reset_committed_marker):
        register, calls = spy_invalidate_fns
        register("shipment_schedules")

        @cd.invalidate_cache_on_commit_l1(
            domains=["shipment_schedules"], project_id_from="path"
        )
        def endpoint(project_id: int) -> str:
            raise HTTPException(status_code=422)

        with pytest.raises(HTTPException):
            endpoint(project_id=1)
        assert calls == {}


class TestFastAPIDecoratorUnregisteredDomain:
    """A8: FastAPI 装饰器域未登记 → KeyError。"""

    def test_unregistered_domain_raises_keyerror(self):
        with pytest.raises(KeyError, match="未登记"):

            @cd.invalidate_cache_on_commit(domains=["nope"], project_id_from="path")
            def endpoint(project_id: int) -> str:
                return "ok"

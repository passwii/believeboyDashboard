"""A 类不变量测试：已装饰但未实际失效的 8 个场景（BLF-665 子 #1）。

设计 §7.1：

| # | 场景 | 防护 |
|---|---|---|
| A1 | 函数抛异常 → 不失效（fail-safe） | 装饰器 fail-safe |
| A2 | 未 mark → log warning，失效失败 | 提醒业务漏 mark |
| A3 | project_id 解析失败 → 触发全量失效 | 防御缺失参数 |
| A4 | 域未注册 → 启动期 KeyError | typo 拦截 |
| A5 | L0 拒绝 on_error="log" | 防御 L0 best_effort |
| A6 | extra_project_ids 回调异常 → 主 project_id 仍失效 | 防御回调挂掉 |
| A7 | FastAPI 抛 HTTPException → 不失效 | 防御 4xx 误失效 |
| A8 | FastAPI 域未注册 → 启动期 KeyError | typo 拦截 |

用 spy invalidate_fn + 内存 store，不依赖本地 Redis。
"""

from __future__ import annotations

import logging

import pytest
from fastapi import HTTPException

from app.services.infra import cache_decorator as cd
from app.services.infra.cache_write_endpoints import ALL_WRITE_ENDPOINTS


class TestA1FailSafeOnException:
    """A1：函数抛异常 → 不失效。"""

    def test_sync_exception_skips_invalidation(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        spy = spy_invalidate_fns(["inventory_replenishment"])["inventory_replenishment"]

        @cd.invalidate_cache_on_commit(
            domains=["inventory_replenishment"], project_id_from="arg"
        )
        def boom(project_id: int):
            raise RuntimeError("business failure")

        with pytest.raises(RuntimeError):
            boom(project_id=7)
        assert spy.calls == [], "函数抛异常时不得失效（A1 fail-safe）"


class TestA2MissingMarkWarning:
    """A2：Celery 任务未 mark → log warning，不失效。"""

    def test_celery_unmarked_logs_warning_and_skips(
        self, spy_invalidate_fns, reset_committed_marker, caplog
    ):
        spy = spy_invalidate_fns(["inventory_replenishment"])["inventory_replenishment"]

        @cd.invalidate_cache_on_commit_celery(
            domains=["inventory_replenishment"], project_id_from="arg"
        )
        def task(project_id: int):
            # 模拟 Celery 任务：commit 了但漏调 mark_committed()
            return "ok"

        with caplog.at_level(
            logging.WARNING, logger="app.services.infra.cache_decorator"
        ):
            result = task(project_id=3)

        assert result == "ok"
        assert spy.calls == [], "未 mark 不得失效（A2）"
        assert "mark_committed" in caplog.text, "应 log warning 提醒漏 mark"

    def test_celery_marked_invalidates(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        spy = spy_invalidate_fns(["inventory_replenishment"])["inventory_replenishment"]

        @cd.invalidate_cache_on_commit_celery(
            domains=["inventory_replenishment"], project_id_from="arg"
        )
        def task(project_id: int):
            cd.mark_committed()
            return "ok"

        task(project_id=3)
        assert [c.project_id for c in spy.calls] == [3], "已 mark 应正常失效"


class TestA3ResolveFailureFullInvalidate:
    """A3：project_id 解析失败 → 触发全量失效（project_id=None）。"""

    def test_missing_project_id_falls_back_to_full(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        spy = spy_invalidate_fns(["data_management"])["data_management"]

        @cd.invalidate_cache_on_commit(
            domains=["data_management"], project_id_from="path"
        )
        def no_pid_endpoint(sku: str):
            return "ok"

        # 直接调用（无 FastAPI Request，kwargs 无 project_id）→ 解析失败 → 全量失效
        no_pid_endpoint(sku="X")
        assert len(spy.calls) == 1
        assert spy.calls[0].project_id is None, (
            "解析失败应触发全量失效（project_id=None）"
        )

    def test_kwargs_project_id_resolves_normally(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        spy = spy_invalidate_fns(["inventory_replenishment"])["inventory_replenishment"]

        @cd.invalidate_cache_on_commit(
            domains=["inventory_replenishment"], project_id_from="path"
        )
        def endpoint(project_id: int):
            return "ok"

        endpoint(project_id=99)  # kwargs 直接注入 → 正常解析
        assert [c.project_id for c in spy.calls] == [99]


class TestA4UnregisteredDomainKeyError:
    """A4：域未注册 → 启动期 KeyError。"""

    def test_unregistered_domain_raises_at_decorate_time(self):
        with pytest.raises(KeyError):

            @cd.invalidate_cache_on_commit(domains=["typo_domain_xyz"])
            def endpoint():
                return "ok"


class TestA5L0RejectsLog:
    """A5：L0 拒绝 on_error="log"。"""

    def test_l0_on_error_log_raises_value_error(self):
        with pytest.raises(ValueError, match="on_error"):

            @cd.invalidate_cache_on_commit(
                domains=["inventory_replenishment"], on_error="log"
            )
            def endpoint():
                return "ok"

    def test_l1_requires_log(self):
        """L1 装饰器不接受 on_error 参数（§5.2 钉死：永远 log）。"""
        with pytest.raises(TypeError):

            @cd.invalidate_cache_on_commit_l1(
                domains=["shipment_schedules"], on_error="raise"
            )
            def endpoint():
                return "ok"

    def test_l1_failure_is_best_effort(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        """L1 失效失败不阻断业务（best_effort：log 后继续）。"""
        spy = spy_invalidate_fns(["shipment_schedules"])["shipment_schedules"]
        spy.raise_on_call = RuntimeError("redis down")

        @cd.invalidate_cache_on_commit_l1(domains=["shipment_schedules"])
        def endpoint(project_id: int):
            return "ok"

        # L1 失效抛错应被吞掉，业务正常返回
        assert endpoint(project_id=3) == "ok"


class TestA6ExtraProjectIdsCallbackFailure:
    """A6：extra_project_ids 回调异常 → 主 project_id 仍失效。"""

    def test_callback_exception_still_invalidates_main(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        spy = spy_invalidate_fns(["crm"])["crm"]

        def bad_extra(args, kwargs, rv):
            raise RuntimeError("callback exploded")

        @cd.invalidate_cache_on_commit(
            domains=["crm"],
            project_id_from="payload",
            extra_project_ids=bad_extra,
        )
        def batch_transfer(payload):
            return "ok"

        class Payload:
            project_id = 5

        batch_transfer(Payload())
        assert [c.project_id for c in spy.calls] == [5], (
            "回调异常时主 project_id 仍应失效（A6）"
        )


class TestA7HttpExceptionNoInvalidate:
    """A7：FastAPI 抛 HTTPException → 不失效（4xx 防御）。"""

    def test_http_exception_skips_invalidation(
        self, spy_invalidate_fns, reset_committed_marker
    ):
        spy = spy_invalidate_fns(["platform_revenues"])["platform_revenues"]

        @cd.invalidate_cache_on_commit(
            domains=["platform_revenues"], project_id_from="path"
        )
        def endpoint(project_id: int):
            raise HTTPException(status_code=400, detail="bad request")

        with pytest.raises(HTTPException):
            endpoint(project_id=7)
        assert spy.calls == [], "HTTPException（4xx）不得失效（A7）"


class TestA8FastAPIUnregisteredDomainKeyError:
    """A8：FastAPI 域未注册 → 启动期 KeyError（与 A4 同机制，覆盖 FastAPI 路径）。"""

    def test_fastapi_unregistered_domain_raises(self):
        with pytest.raises(KeyError):

            @cd.invalidate_cache_on_commit(
                domains=["no_such_domain"], project_id_from="path"
            )
            def endpoint(project_id: int):
                return "ok"


class TestLayerBasics:
    """分层表完整性：REGISTERED_DOMAINS 覆盖设计全部域。"""

    def test_all_registered_domains_are_known(self):
        assert set(cd.REGISTERED_DOMAINS.keys()) >= set(cd.L0_DOMAINS) | set(
            cd.L1_DOMAINS
        ) | set(cd.L2_DOMAINS)

    def test_domain_layers_strength(self):
        for domain in cd.L0_DOMAINS:
            assert cd._LAYER_STRENGTH[domain] == 3, f"{domain} 应为 L0"
        for domain in cd.L1_DOMAINS:
            assert cd._LAYER_STRENGTH[domain] == 2, f"{domain} 应为 L1"
        for domain in cd.L2_DOMAINS:
            assert cd._LAYER_STRENGTH[domain] == 1, f"{domain} 应为 L2"

    def test_whitelist_domains_registered(self):
        for spec in ALL_WRITE_ENDPOINTS():
            assert spec.domain in cd.REGISTERED_DOMAINS, (
                f"白名单域 {spec.domain} 未注册（{spec.module}.{spec.function}）"
            )

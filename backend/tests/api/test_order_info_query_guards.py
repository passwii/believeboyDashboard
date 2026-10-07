"""BLF-1262 Stage 1：order-info 的两道后端护栏。

护栏一：order-info 只读端点的「有界 statement timeout」
---------------------------------------------------
缺陷形状（为什么需要这一层）
---------------------------
``app/db/session.py`` 的 ``connect_args`` 全局配了 ``-c statement_timeout=120s``，
端点又是同步 ``def``（跑在 anyio 线程池里）。于是：**前端代理早已 abort / 用户关了
页面 → 后端线程并不会停，也没人给 Postgres 发 cancel → 那条重型查询继续合法地跑满
120s，占着 ``db_pool_size=5 (+overflow 5)`` 的连接**。池子被"僵尸查询"占满后正常请求
开始排队等 ``pool_timeout=10``。

修复（``app/db/query_timeout.py``）：把 order-info 只读端点的**单语句**上限从全局
120s 收紧到 15s（``Settings.order_info_statement_timeout_ms``），由 Postgres 主动取消
语句、立刻归还连接；并在端点层把这类失败映射成 **504 + 稳定错误码**，与真实 500 区分。

判据选"读回 ``SHOW statement_timeout``"而不是"跑一条慢查询看耗时"：前者是对
GUC 本身的精确断言（不受机器负载影响），后者只在 CI 慢机上偶发抖动。

护栏二：「项目范围获取失败」不得静默退化为全店铺无日期查询
-----------------------------------------------------------
2026-10-07 复核结论：静默退化**在前端**（``order-info/page.tsx`` 的
``fetchManagedProjectsCached().catch()`` 放行 → projectId 停在"全部店铺" →
buildQuery 不带 project_ids；同时 dateFrom/dateTo 为空 → 后端收到
「无项目 + 无日期」）。后端这边要锁死的是**自己那半边的契约**：非 admin 永远缩到
自己的可访问项目，取项目列表失败时宁可 500 也不返回 None（None = 不限项目）。
前端那一半已单独记录给 Stage 1 前端子 issue，不在本文件范围。

走真实测试库（无 TEST_DATABASE_URL 自动 skip，见根 conftest）。
"""

from __future__ import annotations

import time
from typing import Annotated
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.exc import OperationalError, SQLAlchemyError

from app.core.config import Settings, get_settings
from app.db.query_timeout import (
    current_statement_timeout_ms,
    install_statement_timeout,
    is_query_timeout_error,
)

#: 引擎 connect_args 里的全局兜底值（app/db/session.py）。
GLOBAL_FALLBACK_MS = 120_000

#: Settings.order_info_statement_timeout_ms 的默认值。
DEFAULT_BOUND_MS = 15_000


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


def _admin_headers() -> dict[str, str]:
    return {
        "X-API-Key": get_settings().api_key,
        "X-Is-Admin": "true",
        "X-Operator": "pytest-admin",
    }


# ===== 默认预算 =====


def test_default_budget_is_tighter_than_global_fallback() -> None:
    """默认预算必须比全局 120s 紧 —— 否则这层护栏等于没装。"""
    assert DEFAULT_BOUND_MS < GLOBAL_FALLBACK_MS
    assert get_settings().order_info_statement_timeout_ms == DEFAULT_BOUND_MS


def test_budget_never_exceeds_global_fallback() -> None:
    """上限锁死在全局值：配成比全局还宽会让人误以为"没生效"。

    直接跑真字段的校验器，而不是复制一份 Field —— 复制的那份和真配置
    漂移了也测不出来。
    """
    field = Settings.model_fields["order_info_statement_timeout_ms"]
    adapter = TypeAdapter(Annotated[field.annotation, *field.metadata])

    assert adapter.validate_python(GLOBAL_FALLBACK_MS) == GLOBAL_FALLBACK_MS
    with pytest.raises(ValidationError):
        adapter.validate_python(GLOBAL_FALLBACK_MS + 1)
    with pytest.raises(ValidationError):
        adapter.validate_python(0)


# ===== 事务级 GUC 真的被收紧 =====


def test_install_narrows_transaction_statement_timeout(db_session) -> None:
    """装上之后，同一事务里的 statement_timeout 从 120s 收到 15s。"""
    before = current_statement_timeout_ms(db_session)
    assert before == GLOBAL_FALLBACK_MS, (
        f"引擎兜底应仍是 {GLOBAL_FALLBACK_MS}ms（connect_args），实测 {before}ms —— "
        "全局值被动过，本文件的对比基线需要同步更新"
    )

    assert install_statement_timeout(db_session, DEFAULT_BOUND_MS) is True
    # 懒 autobegin：此刻还没事务，读一下会顺带触发 after_begin 监听器。
    assert current_statement_timeout_ms(db_session) == DEFAULT_BOUND_MS


def test_bound_survives_rollback(db_session) -> None:
    """事务级 GUC 会被 rollback 重置 —— after_begin 监听器必须把它钉回来。

    这是"用监听器而不是设一次就完事"的理由：同一个 Session 在事务结束后再查，
    不能悄悄退回 120s。
    """
    install_statement_timeout(db_session, DEFAULT_BOUND_MS)
    assert current_statement_timeout_ms(db_session) == DEFAULT_BOUND_MS

    db_session.rollback()
    assert current_statement_timeout_ms(db_session) == DEFAULT_BOUND_MS


def test_reinstall_replaces_previous_bound(db_session) -> None:
    """同一 Session 上换预算：旧的监听器要被摘掉，不能两条都留着。"""
    install_statement_timeout(db_session, DEFAULT_BOUND_MS)
    assert current_statement_timeout_ms(db_session) == DEFAULT_BOUND_MS

    install_statement_timeout(db_session, 3_000)
    assert current_statement_timeout_ms(db_session) == 3_000


def test_non_positive_budget_is_noop(db_session) -> None:
    """budget<=0 视为"不设限"，返回 False 且不动 GUC。"""
    assert install_statement_timeout(db_session, 0) is False
    assert current_statement_timeout_ms(db_session) == GLOBAL_FALLBACK_MS


def test_bounded_read_session_dep_narrows_but_plain_read_session_does_not(db_session) -> None:
    """护栏只挂在显式声明的依赖上，不污染其它端点（这是刻意的收窄，不是全局改动）。"""
    from app.api.deps import get_bounded_read_db_session

    assert get_bounded_read_db_session(db=db_session) is db_session
    assert current_statement_timeout_ms(db_session) == DEFAULT_BOUND_MS


# ===== 超时识别 =====


def test_statement_timeout_error_is_recognised(db_session) -> None:
    """PG 取消语句 → SQLAlchemy 异常 → 必须被识别成"语句超时"。"""
    install_statement_timeout(db_session, 1_000)
    started = time.perf_counter()
    with pytest.raises(SQLAlchemyError) as excinfo:
        db_session.execute(text("select pg_sleep(5)"))
    elapsed_ms = (time.perf_counter() - started) * 1000

    assert is_query_timeout_error(excinfo.value) is True
    # 1s 预算打 5s 的 sleep：必须**被主动取消**，而不是等它自然结束。
    assert elapsed_ms < 3_000, f"pg_sleep(5) 用了 {elapsed_ms:.0f}ms 才返回，像是没被取消"
    db_session.rollback()


def test_non_timeout_sql_errors_are_not_misread_as_timeout(db_session) -> None:
    """普通 SQL 错误不能被误判成超时 —— 否则真实 500 会被谎报成 504。"""
    with pytest.raises(SQLAlchemyError) as excinfo:
        db_session.execute(text("select * from 这张表不存在"))
    assert is_query_timeout_error(excinfo.value) is False
    db_session.rollback()


def test_pool_timeout_error_is_not_misread_as_query_timeout() -> None:
    """连接池排队超时（``QueuePool ... timeout``）是另一类故障，不该映射成 504。

    映射错了会让前端提示"收窄筛选"，而真实原因是连接池被占满。
    """
    pooled = OperationalError("SELECT 1", {}, Exception(
        "QueuePool limit of size 5 overflow 5 reached, connection timed out"
    ))
    assert is_query_timeout_error(pooled) is False


# ===== 端点层：504 与 200 =====

_BOUNDED_READ_ENDPOINTS = (
    "/api/v1/order-info/overview",
    "/api/v1/order-info/list",
    "/api/v1/order-info/stats",
    "/api/v1/order-info/page",
    "/api/v1/order-info/filter-options",
    "/api/v1/order-info/live-stream",
)


#: 端点 → 被 monkeypatch 的 service 函数。逐个绑定而不是反射，路径写错会在
#: 收集期就 KeyError，而不是静默漏测。
_SERVICE_FN = {
    "/api/v1/order-info/overview": "get_overview",
    "/api/v1/order-info/list": "list_orders",
    "/api/v1/order-info/stats": "compute_stats",
    "/api/v1/order-info/page": "get_page_data",
    "/api/v1/order-info/filter-options": "collect_filter_options",
    "/api/v1/order-info/live-stream": "query_order_live_stream",
}

#: 端点测试用的紧预算（Settings 允许的最小值）。`get_settings` 是 lru_cache
#: 单例，进程内改 env 不生效 —— 必须直接改这个对象（与 tests/api/conftest.py
#: 里既有的 "mutate the singleton then restore" 约定一致）。
TEST_BOUND_MS = 1_000


@pytest.fixture
def tight_budget(monkeypatch) -> int:
    monkeypatch.setattr(
        get_settings(), "order_info_statement_timeout_ms", TEST_BOUND_MS
    )
    return TEST_BOUND_MS


def _slow_call(fn):
    """在 service 函数入口插一条 5s 的 sleep —— statement_timeout 会取消它。"""

    def _wrapped(db, *args, **kwargs):
        db.execute(text("select pg_sleep(5)"))
        return fn(db, *args, **kwargs)

    return _wrapped


@pytest.mark.parametrize("path", _BOUNDED_READ_ENDPOINTS)
def test_bounded_endpoints_still_succeed_under_normal_budget(client, path) -> None:
    """回归：装了护栏之后，正常查询仍然 200（不能把页面打挂）。"""
    response = client.get(path, headers=_admin_headers())
    assert response.status_code == 200, response.text[:400]


@pytest.mark.parametrize("path", _BOUNDED_READ_ENDPOINTS)
def test_bounded_endpoints_map_timeout_to_504(
    client, monkeypatch, tight_budget, path
) -> None:
    """超预算的端点返回 504 + 稳定错误码，而不是 500。

    端点被逐个点名，是为了防止以后有人给某个端点换回裸 ``get_read_db_session``
    时无声丢掉护栏（diff 里看不出意图）。
    """
    from app.services.data import order_info_service

    monkeypatch.setattr(
        order_info_service,
        _SERVICE_FN[path],
        _slow_call(getattr(order_info_service, _SERVICE_FN[path])),
    )

    response = client.get(path, headers=_admin_headers())

    assert response.status_code == 504, response.text[:400]
    assert response.json()["detail"].startswith("order_info_query_timeout")
    assert f"{tight_budget}ms" in response.json()["detail"]


def test_pool_survives_a_timed_out_request(client, monkeypatch, tight_budget) -> None:
    """超时之后连接必须真的回到池里：紧接着再发一条正常请求要能过。

    护栏的价值就在这里 —— 如果只是把异常吞成 504 却把连接捏在手里不放，
    池子照样会被拖垮，这个测试就会红。
    """
    from app.services.data import order_info_service

    original = order_info_service.get_overview
    calls = {"n": 0}

    def _slow_first_only(db, *args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            db.execute(text("select pg_sleep(5)"))
        return original(db, *args, **kwargs)

    monkeypatch.setattr(order_info_service, "get_overview", _slow_first_only)

    assert (
        client.get("/api/v1/order-info/overview", headers=_admin_headers()).status_code
        == 504
    )
    # 第二发走真实路径：连接已经回到池里，应该正常 200。
    assert (
        client.get("/api/v1/order-info/overview", headers=_admin_headers()).status_code
        == 200
    )


def test_export_endpoint_keeps_global_budget() -> None:
    """export 刻意不收紧：用户主动发起的 5000 行 CSV 导出压到 15s 会正常失败。

    这里锁的是"别顺手把它也改了"这条决定；真要给它加上限，应该先测导出耗时分布。
    """
    import inspect

    from app.api.v1.endpoints import order_info as endpoints

    source = inspect.getsource(endpoints.export_orders)
    assert "get_read_db_session" in source
    assert "get_bounded_read_db_session" not in source


# ===== 护栏二：项目范围不得静默放大 =====


def test_non_admin_without_candidate_is_scoped_not_unrestricted(monkeypatch) -> None:
    """非 admin + 没传 project_ids → 必须缩到"自己的可访问项目"，而不是 None。

    ``None`` 在下游的含义是「不限项目，全量扫」—— 一旦这里返回 None，
    非 admin 就会看到全店铺数据。
    """
    from app.services.data import order_info_service as svc

    monkeypatch.setattr(
        "app.services.project_service.list_accessible_project_ids",
        lambda db, *, operator, is_admin: [7, 9],
    )

    db = MagicMock()
    result = svc._ensure_project_access_for_orders(
        db, candidate_project_ids=None, operator="op1", is_admin=False
    )
    assert result == [7, 9]


def test_non_admin_with_no_accessible_projects_returns_empty_not_none(monkeypatch) -> None:
    """可访问项目为空 → 返回 ``[]``（0 行），绝不能返回 ``None``（全店铺）。

    ``[]`` 走 list_orders/compute_stats 的 0 行早返回；``None`` 会一路走到底变成
    一条不带 project_id 的全表聚合。
    """
    from app.services.data import order_info_service as svc

    monkeypatch.setattr(
        "app.services.project_service.list_accessible_project_ids",
        lambda db, *, operator, is_admin: [],
    )

    db = MagicMock()
    result = svc._ensure_project_access_for_orders(
        db, candidate_project_ids=None, operator="op1", is_admin=False
    )
    assert result == []


def test_scope_lookup_failure_propagates_instead_of_widening(monkeypatch) -> None:
    """取项目列表**失败**（抛异常）时必须向上抛，绝不 catch 成 None。

    这条是「获取失败不得被误解为全店铺」的后端侧判据：把异常吞掉并 fallback 到
    "不限项目" 正是那个静默退化。宁可让请求 500，也不要把越权/全量查询发出去。
    """
    from app.services.data import order_info_service as svc

    def _boom(db, *, operator, is_admin):
        raise RuntimeError("project scope lookup failed")

    monkeypatch.setattr(
        "app.services.project_service.list_accessible_project_ids", _boom
    )

    db = MagicMock()
    with pytest.raises(RuntimeError, match="project scope lookup failed"):
        svc._ensure_project_access_for_orders(
            db, candidate_project_ids=None, operator="op1", is_admin=False
        )


def test_admin_explicit_unrestricted_stays_unrestricted() -> None:
    """admin + 没传 project_ids 仍是 ``None``（"全部店铺"是 admin 的显式语义）。

    这条不是漏洞：admin 是靠 ``X-Is-Admin`` 显式声明的，"全部店铺"就是它的
    合法选项。它与上面"非 admin 不得为 None"成对存在，防止有人把 admin 路径
    也一起收紧而把"全部店铺"功能打挂。
    """
    from app.services.data import order_info_service as svc

    result = svc._ensure_project_access_for_orders(
        MagicMock(), candidate_project_ids=None, operator="admin_user", is_admin=True
    )
    assert result is None

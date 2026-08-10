"""Agent 命名空间镜像 external 读路由（BLF-459 P1 迁移 + V3 下线）。

设计稿 §6.2：``/external/*`` 每个 GET 路由一对一映射到 ``/agent/*``（同后缀
路径），本模块**程序化**从 ``external_router`` 生成镜像路由，而不是手写 51 条
路由——保证 1:1 映射永不漂移，未来新增 external 读路由自动出现在 agent 侧。

每个镜像路由 = 复用 external handler 函数（``types.FunctionType`` 重建包装
函数并沿 ``__wrapped__`` 保留原签名，FastAPI 按原签名解析 path/query/依赖注入）
+ ``_service_errors()`` 壳翻译（HTTPException → AgentApiError）+
``agent_ok()`` 响应壳。纯读路由不落审计、绕过 Redis 读缓存直查 DB（与
external 行为一致）。

V3（BLF-459）：``/api/v1/external/*`` 已彻底下线（410 Gone 兜底，见
``app/api/v1/endpoints/external_retired.py``），external 模块仅作为本镜像的
handler 来源保留，不再挂载到应用。

例外：
* ``new-product-calculations`` 已在 BLF-457 原生迁移（agent R1 同路径存在），
  镜像会与既有路由冲突 → 排除。
* ``/projects`` 列表无 project_id → 不挂 project_scope；并对受 scope 限制的
  key 做列表过滤（L2 门禁语义，``*`` 全放行时与 external 行为一致）。
* 其余路由统一挂 ``Depends(require_project_scope)``（BLF-441 L2 硬前置）。
"""

from __future__ import annotations

import types
from contextlib import contextmanager
from typing import Any, Callable
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.routing import APIRoute
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import SCOPE_ALL, require_project_scope
from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external import external_router
from app.api.v1.endpoints.external.projects import get_external_projects
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey

# 已原生迁移（BLF-457 agent R1 同路径 / BLF-470 退货分析域 R2/R3 原生替换）→
# 镜像排除。new-product-calculations：agent R1 同路径存在。
# return-analysis / return-analysis-raw：BLF-470 原生实现保持 external §9
# 查询契约 + display 增强 + business_scope 挂载，避免双实现漂移。
# BLF-580：ad_campaigns 域已原生化（agent/ad_campaigns.py 3 条原生路由 + 删除
# external/ad_campaigns.py 端点模块）→ 镜像排除防双挂（源路由已删，排除项
# 为防御性冗余，保底防外部源意外恢复）。
_EXCLUDED_EXTERNAL_PATHS = {
    "/external/projects/{project_id}/new-product-calculations",
    "/external/projects/{project_id}/return-analysis",
    "/external/projects/{project_id}/return-analysis-raw",
    # BLF-502 D1：补货分析已原生化（Agent 任务模型 6 路由）
    "/external/projects/{project_id}/replenishment-analysis",
    # BLF-580：ad_campaigns 已原生化（agent/ad_campaigns.py）
    "/external/projects/{project_id}/ad-campaigns",
    "/external/projects/{project_id}/ad-campaigns-raw",
    "/external/projects/{project_id}/ad-campaign-raw",
    # BLF-581：其余 9 个 ad 域已原生化（agent/ad_*.py 原生路由，26 条）。
    # 源路由已删除，排除项为防御性冗余，保底防外部源意外恢复。
    "/external/projects/{project_id}/ad-budgets",
    "/external/projects/{project_id}/ad-budgets-raw",
    "/external/projects/{project_id}/ad-budget-raw",
    "/external/projects/{project_id}/ad-targets",
    "/external/projects/{project_id}/ad-targets-raw",
    "/external/projects/{project_id}/ad-target-raw",
    "/external/projects/{project_id}/ad-placements",
    "/external/projects/{project_id}/ad-placements-raw",
    "/external/projects/{project_id}/ad-placement-raw",
    "/external/projects/{project_id}/ad-promoted-products",
    "/external/projects/{project_id}/ad-promoted-products-raw",
    "/external/projects/{project_id}/ad-promoted-product-raw",
    "/external/projects/{project_id}/ad-time-trends",
    "/external/projects/{project_id}/ad-time-trends-raw",
    "/external/projects/{project_id}/ad-time-trend-raw",
    "/external/projects/{project_id}/ad-search-terms",
    "/external/projects/{project_id}/ad-search-terms-raw",
    "/external/projects/{project_id}/ad-search-term-raw",
    "/external/projects/{project_id}/ad-search-term-shares",
    "/external/projects/{project_id}/ad-search-term-shares-raw",
    "/external/projects/{project_id}/ad-search-term-share-raw",
    "/external/projects/{project_id}/ad-invalid-traffic",
    "/external/projects/{project_id}/ad-invalid-traffic-raw",
    "/external/projects/{project_id}/ad-purchased-products",
    "/external/projects/{project_id}/ad-purchased-products-raw",
    "/external/projects/{project_id}/ad-purchased-product-raw",
}

_AGENT_PROJECTS_LIST_PATH = "/projects"


# ============================================================
# 版本容错：枚举 external 命名空间的 GET APIRoute
# ============================================================


def _iter_external_apiroutes():
    """版本容错地枚举 ``external_router`` 下所有 GET ``APIRoute``。

    FastAPI < 0.13x：``include_router`` 会把子路由拍平进父 router，
    ``external_router.routes`` 直接是 ``APIRoute``（path 含 ``/external``
    前缀）。FastAPI >= 0.13x（本机 0.115 vs VPS 0.139 实测差异）：子路由被
    包成 ``_IncludedRouter``，真实 ``APIRoute`` 在 ``original_router.routes``
    里且 path 不含前缀。统一 yield ``(全路径含 /external 前缀, APIRoute)``。
    """
    for route in external_router.routes:
        if isinstance(route, APIRoute):
            yield route.path, route
            continue
        inner = getattr(route, "original_router", None)
        if inner is None:
            continue
        for sub in getattr(inner, "routes", []):
            if isinstance(sub, APIRoute):
                yield f"/external{sub.path}", sub


# ============================================================
# 壳翻译与解析 helper（对齐货件/店铺域模板）
# ============================================================


@contextmanager
def _service_errors():
    """把 external handler 抛的 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND, human_message=detail
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None


def _to_json(value: Any) -> Any:
    """pydantic v2 模型 → JSON-safe dict；list / 标量原样返回。"""
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return value


def _make_wrapper(endpoint: Callable, *, name: str) -> Callable:
    """包一层：调 external handler → 壳翻译 → agent_ok。

    用 ``types.FunctionType`` 重建包装函数并把它绑定到 **原 handler 所在模块**
    的 globals（+ 注入本模块的壳 helper），而不是 ``functools.wraps``——
    FastAPI 跟随 ``__wrapped__`` 拿签名，但注解里的 ForwardRef（如
    ``date | None``）按函数自身 ``__globals__`` 解析；wraps 会让包装函数
    的 globals 是本模块（缺 ``date`` 等），``openapi()`` 生成会报
    ``TypeAdapter[ForwardRef('date | None')]`` 未定义。

    返回壳里显式 ``response_model=None``（否则 FastAPI 会把原函数返回注解
    当成 response_model，对 ``{ok, data}`` 壳做校验而 500）。
    """

    def _call(*args: Any, **kwargs: Any) -> dict:
        with _service_errors():
            result = endpoint(*args, **kwargs)
        return agent_ok(_to_json(result))

    globals_ = dict(endpoint.__globals__)
    globals_.update(
        {
            "_service_errors": _service_errors,
            "agent_ok": agent_ok,
            "_to_json": _to_json,
        }
    )
    wrapped = types.FunctionType(
        _call.__code__,
        globals_,
        name=name,
        argdefs=_call.__defaults__,
        closure=_call.__closure__,
    )
    wrapped.__wrapped__ = endpoint  # 让 FastAPI 沿 __wrapped__ 拿原签名
    wrapped.__doc__ = endpoint.__doc__
    return wrapped


def _agent_projects_list(
    request: Request,
    status: str = Query(default="active"),
    name: str | None = Query(default=None),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """``/projects`` 列表专用：复用 external handler + 按 key 的 project_scope 过滤。

    受 scope 限制的 agent key（如 ``project_scope="1,2"``）不应看到全部项目名；
    ``*`` 全放行时行为与 external 完全一致。无 project_id → 不挂 project_scope。

    ``name``（BLF-461）：可选的项目名精确过滤，作为 Agent「名字 → ID」
    的确定性解析步骤——``project_name`` 有唯一约束，命中 0/1 条；
    未命中返回空列表，Agent 据此判断名字写错或项目不存在。
    """
    with _service_errors():
        projects = get_external_projects(status=status, db=db)

    if name:
        projects = [p for p in projects if p.project_name == name]

    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is not None:
        db2 = SessionLocal()
        try:
            key = db2.get(AgentApiKey, key_id)
            scope = (key.project_scope if key else None) or SCOPE_ALL
        finally:
            db2.close()
        if scope != SCOPE_ALL:
            allowed = {int(part.strip()) for part in scope.split(",") if part.strip()}
            projects = [p for p in projects if p.project_id in allowed]

    return agent_ok([_to_json(p) for p in projects])


# ============================================================
# 镜像路由构建
# ============================================================

external_mirror_router = APIRouter(tags=["agent-external-mirror"])

for _ext_path, _route in _iter_external_apiroutes():
    if "GET" not in (_route.methods or set()):
        continue
    if _ext_path in _EXCLUDED_EXTERNAL_PATHS:
        continue

    # 剥掉 /external 即 agent 侧相对路径。
    rel_path = _ext_path[len("/external") :] or "/"
    agent_name = f"agent_{_route.name}"

    if rel_path == _AGENT_PROJECTS_LIST_PATH:
        wrapped: Callable = _agent_projects_list
        deps: list[Depends] = []
    else:
        wrapped = _make_wrapper(_route.endpoint, name=agent_name)
        deps = [Depends(require_project_scope)]

    external_mirror_router.add_api_route(
        rel_path,
        endpoint=wrapped,
        methods=["GET"],
        name=agent_name,
        summary=f"agent 镜像: {_ext_path}",
        tags=["agent-external-mirror"],
        response_model=None,
        dependencies=deps,
    )

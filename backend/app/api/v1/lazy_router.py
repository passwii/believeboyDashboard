"""Lazy group router — 把 endpoint 模块的 import 推迟到首次命中（BLF-657 方案 1）。

背景：Phase 1 画像显示 believeboy-api 的 ~250 MiB traced 内存几乎全部来自
import 机制 + pydantic/sqlalchemy/fastapi 的 schema/mapper 构建，app 业务代码
本身仅 ~3 MiB。唯一有效的杠杆是"首次命中才 import、不做启动预热"，让冷接口的
模块树（endpoint + schemas + services + 传递依赖）在稳态下保持未加载。

实现原理（依赖 fastapi==0.139.0，requirements.txt 已 pin）：
- FastAPI 0.139 的 `include_router` 不再把子路由急切复制进父路由，而是存
  `_IncludedRouter(original_router=...)` 包装，路由树在请求匹配 / openapi 生成
  时才懒物化（`effective_candidates()` 访问 `original_router.routes`）。
- 本 shim 是普通 `APIRouter` 子类。我们覆写 `routes` 属性为加载触发器：首次被
  FastAPI 读取（请求匹配时 `effective_candidates`、或 openapi 生成时
  `iter_route_contexts`）时 `importlib.import_module(模块)` 拿到真实 router 并
  收养其 `routes` / `_routes_version` / 生命周期钩子，之后一切照旧。
- **关键坑**：不能把加载放进 `_get_routes_version()`——app 级 wrapper 的
  `effective_candidates()` 在每次请求匹配时都会遍历父 router 的全部子路由计算
  版本号，若在这里加载会导致每个请求把所有懒分组全部 import，懒加载失效。

行为保证：
- 所有路由路径/行为不变（include 顺序即匹配优先级，原序保留）。
- 首次 `/openapi.json`（含 /docs）会一次性加载全部懒分组——schema 保持完整，
  这是 Phase 1 已接受的一次性 +~40 MiB 成本。
- fastapi < 0.139（无 `_IncludedRouter`）时 `include_lazy_router` 回退为急切
  import，行为与改造前完全一致。
"""

from __future__ import annotations

import importlib
from typing import Any

from fastapi import APIRouter

# fastapi >= 0.139 才有 _IncludedRouter 懒物化机制；旧版本走急切回退。
_HAS_INCLUDED_ROUTER = hasattr(
    __import__("fastapi.routing", fromlist=["x"]), "_IncludedRouter"
)

# 已注册的懒分组（用于 openapi 预加载）。
_LAZY_REGISTRY: list["LazyGroupRouter"] = []


class LazyGroupRouter(APIRouter):
    """注册时保持路由树完整、首次命中才 import 真实 endpoint 模块的 APIRouter。

    对 FastAPI 而言它就是一个普通 APIRouter；加载发生在 `routes` 属性第一次被
    读取时（请求匹配或 openapi 生成），加载后行为与急切版完全一致。
    """

    def __init__(
        self, module_name: str, router_attr: str = "router", **kwargs: Any
    ) -> None:
        self.__dict__["_lazy_module"] = module_name
        self.__dict__["_lazy_attr"] = router_attr
        self.__dict__["_lazy_loaded"] = False
        # __init__ 期间把 routes 读取抑制为空列表，避免误触发加载。
        self.__dict__["_lazy_suppress"] = True
        super().__init__(**kwargs)
        self.__dict__["_lazy_suppress"] = False

    # -- lazy 加载 -----------------------------------------------------------

    def _ensure_loaded(self) -> None:
        """Import 真实 endpoint 模块并收养其 router 状态（幂等、线程安全）。"""
        if self._lazy_loaded:
            return
        real: APIRouter = getattr(
            importlib.import_module(self._lazy_module), self._lazy_attr
        )
        # 收养状态：routes 保持真实引用（Starlette 匹配按需遍历，不复制）。
        # 版本号必须来自真实 router，否则父级版本缓存判定"路由没变"，
        # openapi / effective_candidates 就看不到加载后的新路由。
        self.routes = real.routes
        self._routes_version = real._get_routes_version()
        self.on_startup = real.on_startup
        self.on_shutdown = real.on_shutdown
        self.lifespan_context = real.lifespan_context
        self._lazy_loaded = True

    # -- 覆写 APIRouter 的属性/方法 ------------------------------------------

    @property
    def routes(self) -> list:
        """加载触发器：FastAPI 在匹配 / openapi 遍历时读取 routes。"""
        if self.__dict__.get("_lazy_loaded"):
            return self.__dict__["routes"]
        if self.__dict__.get("_lazy_suppress"):
            return []
        self._ensure_loaded()
        return self.__dict__["routes"]

    @routes.setter
    def routes(self, value: list) -> None:
        self.__dict__["routes"] = value

    def _contains_router(
        self, router: "APIRouter", seen: set[int] | None = None
    ) -> bool:
        # 懒分组永远不会包含父 router；跳过遍历以避免在 include 阶段触发加载。
        return False

    def _get_routes_version(self, seen: set[int] | None = None) -> int:
        # 注意：这里**故意不**触发加载。app 级 wrapper 的 effective_candidates()
        # 在每次请求匹配时都会遍历全部子路由计算版本号；若在此加载会导致每个
        # 请求把所有懒分组全部 import。未加载时返回自身基础版本（0），加载后
        # 委托 super() 用真实 routes/版本计算（从而父级能感知路由变化）。
        if self._lazy_loaded:
            return super()._get_routes_version(seen)
        if seen is None:
            seen = set()
        if id(self) in seen:
            return self._routes_version
        seen.add(id(self))
        return self._routes_version


def preload_all_lazy_groups() -> None:
    """启动后首次 /openapi.json 或 /docs 时调用：一次性加载全部懒分组。

    必须赶在 openapi 生成**之前**完成：`_get_api_route_for_openapi` 返回的是
    `_EffectiveRouteContext` 克隆（每次 `from_api_route` 都会重建 body_field 等
    ModelField）。若生成过程中分组才被加载，`_get_routes_version()` 变化会让
    effective_candidates 缓存失效、重建出新的克隆对象，导致 field_mapping 里
    的旧 field 与新克隆的 field 对不上 → KeyError。预加载后版本稳定，schema
    完整且不再变。
    """
    for shim in _LAZY_REGISTRY:
        shim._ensure_loaded()


def include_lazy_router(
    parent: APIRouter,
    module_name: str,
    router_attr: str = "router",
    **kwargs: Any,
) -> LazyGroupRouter:
    """把懒分组注册进父 router（等价于 include_router，但模块 import 延后）。

    fastapi < 0.139 时回退为急切加载，保证任意版本行为一致。
    """
    shim = LazyGroupRouter(module_name, router_attr)
    _LAZY_REGISTRY.append(shim)
    if not _HAS_INCLUDED_ROUTER:
        shim._ensure_loaded()
    shim.__dict__["_lazy_suppress"] = True
    try:
        parent.include_router(shim, **kwargs)
    finally:
        shim.__dict__["_lazy_suppress"] = False
    return shim

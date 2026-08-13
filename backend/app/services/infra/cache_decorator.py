"""缓存失效治理装饰器基础设施（BLF-666）。

设计来源：`docs/superpowers/specs/2026-08-13-cache-governance-design.md` §5-§7。
本文件实现三层失效装饰器 + Celery ``mark_committed()`` 协议 + 域登记表，
让后续所有缓存治理（BLF-667/668/669）有统一的"写后失效"机制可依，
把 BLF-633 类根因（写路径漏调 invalidate → 最长 5 分钟旧值）从"手工纪律"
变成"机制强制"。

核心概念
--------
- **域（domain）**：一个缓存域，例如 ``inventory_replenishment``。所有域
  必须先登记到 ``REGISTERED_DOMAINS``（启动期硬校验，域未注册 = KeyError）。
- **层（layer）**：L0 强一致 / L1 弱一致 / L2 省 token。层决定装饰器约束
  （L0 拒绝 ``on_error="log"``；L1 强制 best_effort，无 cascade）。
- **失效函数注入**：域登记表**不含** invalidate_fn 引用；由各域模块启动时
  调用 ``register_invalidate_fn(domain, fn)`` 注入，装饰器通过查表执行。
- **Celery 协议**：Celery 写任务 commit 后必须调用 ``mark_committed()``；
  任务返回时装饰器检查标记，已标记才执行失效，未标记记 warning。

API 一览
--------
- ``REGISTERED_DOMAINS`` / ``register_invalidate_fn(domain, fn)``
- ``invalidate_cache_on_commit(domains=..., project_id_from=..., ...)`` — L0 强一致
- ``invalidate_cache_on_commit_l1(domains=..., ...)`` — L1 弱一致（best_effort）
- ``invalidate_cache_on_commit_celery(domains=..., ...)`` — Celery 任务装饰器
- ``mark_committed()`` / ``reset_committed()`` / ``auto_commit(db)`` — Celery 协议
"""

from __future__ import annotations

import functools
import inspect
import logging
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Iterator, Literal

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# ── 层定义 ────────────────────────────────────────────────────────────

Layer = Literal["L0", "L1", "L2"]

# L0 强一致：写后立即失效，失效失败必须可见（raise），不允许静默 log。
# L1 弱一致：best_effort，on_error 永远 log，短 TTL（5min）兜底自动愈合。
# L2 省 token：机制同 L0（长 TTL + 写即失效），优化目标不同（防重复计费）。


@dataclass(frozen=True)
class DomainSpec:
    """域元数据（登记表条目）。"""

    name: str
    layer: Layer
    # 写该域时级联失效的其他域（仅 L0 允许 cascade；L1 强制无 cascade）
    cascade: tuple[str, ...] = ()


# ── 域登记表 ──────────────────────────────────────────────────────────
# 首版登记：10 L0 + 9 L1 + 2 L2 = 21 个域（设计 doc §4 清单）。
# 登记表**不含** invalidate_fn 引用——由各域模块注入（register_invalidate_fn）。

REGISTERED_DOMAINS: dict[str, DomainSpec] = {
    # L0 强一致（10）
    "commission_records": DomainSpec("commission_records", "L0"),
    "commission_ratio_overrides": DomainSpec("commission_ratio_overrides", "L0"),
    "commission_role_assignments": DomainSpec("commission_role_assignments", "L0"),
    "commission_summary": DomainSpec("commission_summary", "L0"),
    "crm": DomainSpec("crm", "L0"),
    "crm_tasks": DomainSpec("crm_tasks", "L0"),
    "inventory_replenishment": DomainSpec("inventory_replenishment", "L0"),
    "platform_revenues": DomainSpec("platform_revenues", "L0"),
    "data_management": DomainSpec("data_management", "L0"),
    "operator_performance": DomainSpec("operator_performance", "L0"),
    # L1 弱一致（9）
    "shipment_schedules": DomainSpec("shipment_schedules", "L1"),
    "inventory_analysis": DomainSpec("inventory_analysis", "L1"),
    "inventory_snapshot_options": DomainSpec("inventory_snapshot_options", "L1"),
    "return_analysis": DomainSpec("return_analysis", "L1"),
    "sku_info": DomainSpec("sku_info", "L1"),
    "report_reconciliation": DomainSpec("report_reconciliation", "L1"),
    "office": DomainSpec("office", "L1"),
    "product_analysis": DomainSpec("product_analysis", "L1"),
    "daily_analysis": DomainSpec("daily_analysis", "L1"),
    # L2 省 token（2）
    "ai_chat_v2": DomainSpec("ai_chat_v2", "L2"),
    "ai_insight": DomainSpec("ai_insight", "L2"),
}

# 域 → invalidate_fn（由各域模块注入；未注入的域失效时记 warning 并跳过）
_INVALIDATE_FNS: dict[str, Callable[..., int | None]] = {}


def register_invalidate_fn(domain: str, fn: Callable[..., int | None]) -> None:
    """注入某域的实际失效函数。

    各域模块（如 inventory_cache.py）启动时调用：
        register_invalidate_fn("inventory_replenishment",
                               invalidate_inventory_replenishment_cache)

    Args:
        domain: 必须已在 REGISTERED_DOMAINS 登记，否则 KeyError。
        fn: 失效函数。约定签名 ``fn(project_id: int | None = None) -> int``
            （返回删除的 key 数；兼容现有 invalidate_* 函数形态）。
    """
    if domain not in REGISTERED_DOMAINS:
        raise KeyError(f"缓存域未登记: {domain!r}（请先加入 REGISTERED_DOMAINS）")
    _INVALIDATE_FNS[domain] = fn


def get_invalidate_fn(domain: str) -> Callable[..., int | None] | None:
    """读取某域已注入的失效函数（测试/工具用）。未注入返回 None。"""
    return _INVALIDATE_FNS.get(domain)


# ── Celery mark_committed 协议 ────────────────────────────────────────
# ContextVar：跨调用栈可见（Celery 任务内部 commit 后标记，返回时装饰器读取）。
_COMMITTED: ContextVar[bool] = ContextVar("cache_decorator_committed", default=False)


def mark_committed() -> None:
    """标记本次任务已 commit（Celery 写任务在 db.commit() 后调用）。"""
    _COMMITTED.set(True)


def reset_committed() -> None:
    """清除提交标记（任务异常/测试隔离时调用）。"""
    _COMMITTED.set(False)


def is_committed() -> bool:
    """当前调用栈是否已标记 commit。"""
    return _COMMITTED.get()


@contextmanager
def auto_commit(db) -> Iterator[Any]:
    """Celery 任务提交上下文：commit 成功 → 自动 mark_committed()。

    用法（替换裸 ``db.commit()``）::

        with auto_commit(db):
            row = upsert_...(db, ...)

    失败时自动 rollback + 重新抛出，且**不**标记 committed
    （异常路径装饰器不会失效缓存——A1 场景）。
    """
    try:
        yield db
        db.commit()
        mark_committed()
    except Exception:
        db.rollback()
        raise


# ── 失效执行 ──────────────────────────────────────────────────────────


def _call_invalidate(
    fn: Callable, project_id: int | None, resource_id: Any
) -> int | None:
    """调用失效函数，按签名决定是否传入 project_id / resource_id。

    现有 invalidate_* 有几种形态:
    - ``invalidate_platform_revenue_cache()`` —— 无参（全局失效）
    - ``invalidate_inventory_replenishment_cache(project_id)`` —— 位置参数
    - 未来可扩展 ``fn(project_id, resource_id=...)`` —— 资源级收敛
    用 inspect 判参，避免对旧函数传多余参数。
    """
    sig = inspect.signature(fn)
    params = list(sig.parameters.values())
    kwargs: dict[str, Any] = {}
    if resource_id is not None and any(p.name == "resource_id" for p in params):
        kwargs["resource_id"] = resource_id
    if not params:
        return fn()
    first = params[0]
    if first.kind in (
        inspect.Parameter.POSITIONAL_ONLY,
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
    ):
        return fn(project_id, **kwargs)
    if first.kind == inspect.Parameter.KEYWORD_ONLY and first.name == "project_id":
        return fn(project_id=project_id, **kwargs)
    return fn(**kwargs)


def _safe_invalidate(
    domains: Iterable[str],
    project_ids: list[int | None] | None = None,
    *,
    cascade: tuple[str, ...] = (),
    resource_id: Any = None,
    on_error: Literal["raise", "log"] = "raise",
    context: str = "",
) -> None:
    """统一失效执行：按域查表调用 invalidate_fn，逐个 project_id 执行。

    异常策略:
    - ``on_error="raise"``（L0）: 失效失败上抛（强一致——静默吞掉 = 用户看到旧值，
      这是 BLF-633 根因，L0 不允许 log）。
    - ``on_error="log"``（L1）: 失败记 warning 继续（best_effort，短 TTL 兜底）。

    Args:
        domains: 要失效的域列表。
        project_ids: 项目级收敛；None/空 → 全量失效（invalidate_fn(project_id=None)）。
        cascade: 级联失效的额外域。
        resource_id: 资源级收敛 ID（由 _resolve_resource_id 解析）。
        on_error: 异常策略（"raise" / "log"）。
        context: 日志上下文（如函数名），便于定位。
    """
    targets = list(dict.fromkeys([*domains, *cascade]))  # 去重保序
    ids = project_ids or [None]
    first_error: Exception | None = None

    for domain in targets:
        fn = _INVALIDATE_FNS.get(domain)
        if fn is None:
            # 域已登记但未注入失效函数 → 记 warning 跳过（注入是各域模块的职责）
            logger.warning(
                "cache_decorator: 域 %r 未注入 invalidate_fn，跳过失效%s",
                domain,
                f"（{context}）" if context else "",
            )
            continue
        for pid in ids:
            try:
                _call_invalidate(fn, pid, resource_id)
            except Exception as exc:  # noqa: BLE001 —— 统一按 on_error 策略处理
                if on_error == "raise" and first_error is None:
                    first_error = exc
                logger.warning(
                    "cache_decorator: 域 %r 失效失败（project_id=%r）: %s%s",
                    domain,
                    pid,
                    exc,
                    f"（{context}）" if context else "",
                )

    if first_error is not None and on_error == "raise":
        raise first_error


# ── 项目 ID / 资源 ID 解析 ────────────────────────────────────────────
# 5 种解析策略（设计 doc §5）：
#   path    — 从路径参数取（FastAPI 端点通常 kwargs 里有 project_id）
#   query   — 从 query 参数取
#   payload — 从请求体取（payload.project_id）
#   arg     — 从函数位置参数取（Celery 任务）
#   global  — 不限项目（全量失效）
# 支持 "path:sku" 形式指定 resource_id 的取值来源。


def _resolve_project_ids(
    project_id_from: str,
    args: tuple,
    kwargs: dict,
    fn: Callable,
) -> list[int | None]:
    """按策略解析项目 ID 列表。

    返回值约定:
    - 返回 ``[project_id]`` → 项目级收敛失效；
    - 返回 ``[None]`` → 全量失效（兼容现有 invalidate_*(project_id=None) 语义）；
    - 返回 ``[id1, id2, ...]`` → 多项目收敛（cascade 跨项目写场景）。

    解析失败（字段缺失/格式错误）→ 抛 ValueError，由调用方决定是否兜底全量。
    """
    source, _, param_name = project_id_from.partition(":")
    name = param_name or "project_id"

    if source == "global":
        return [None]

    if source == "path":
        # FastAPI 路径参数会进 kwargs；也兼容直接传参
        if name in kwargs:
            return [kwargs[name]]
        # request.path_params 兜底（async 端点常从 request 取）
        request = kwargs.get("request")
        path_params = getattr(request, "path_params", {}) or {}
        if name in path_params:
            return [path_params[name]]
        raise ValueError(f"路径参数缺少 {name!r}")

    if source == "query":
        request = kwargs.get("request")
        query = getattr(request, "query_params", {}) or {}
        if name in query:
            return [query[name]]
        raise ValueError(f"query 参数缺少 {name!r}")

    if source == "payload":
        payload = kwargs.get("payload")
        if payload is None:
            payload = kwargs.get("body")
        if payload is None:
            raise ValueError("请求体缺失（payload/body 参数不存在）")
        if isinstance(payload, dict):
            value = payload.get(name)
        else:
            value = getattr(payload, name, None)
        if value is None:
            raise ValueError(f"请求体缺少 {name!r}")
        return [value]

    if source == "arg":
        # Celery 任务：优先 kwargs，其次按签名位置匹配
        if name in kwargs:
            return [kwargs[name]]
        try:
            sig = inspect.signature(fn)
            bound = sig.bind_partial(*args)
            if name in bound.arguments:
                return [bound.arguments[name]]
        except (TypeError, ValueError):
            pass
        raise ValueError(f"函数参数缺少 {name!r}")

    raise ValueError(f"未知 project_id_from 策略: {project_id_from!r}")


def _resolve_resource_id(
    resource_id_from: str | None,
    args: tuple,
    kwargs: dict,
) -> Any | None:
    """解析资源 ID（如 ``"path:sku"`` → kwargs["sku"]）。无声明返回 None。"""
    if not resource_id_from:
        return None
    source, _, name = resource_id_from.partition(":")
    if source == "path":
        if name in kwargs:
            return kwargs[name]
        request = kwargs.get("request")
        path_params = getattr(request, "path_params", {}) or {}
        return path_params.get(name)
    if source == "query":
        request = kwargs.get("request")
        query = getattr(request, "query_params", {}) or {}
        return query.get(name)
    if source == "payload":
        payload = kwargs.get("payload") or kwargs.get("body")
        if isinstance(payload, dict):
            return payload.get(name)
        return getattr(payload, name, None) if payload is not None else None
    if source == "arg":
        return kwargs.get(name)
    return None


# ── 装饰器参数校验（启动期，装饰时执行） ─────────────────────────────


def _validate_decorator_args(
    layer: Layer,
    domains: Iterable[str],
    project_id_from: str,
    on_error: str,
    cascade: Iterable[str] | None = (),
    resource_id_from: str | None = None,
    *,
    celery: bool = False,
) -> None:
    """装饰器参数启动期硬校验（设计 doc §5.5 / 验收标准）。

    校验规则:
    1. 域必须已在 REGISTERED_DOMAINS 登记（未注册 → KeyError，A4/A8 场景）。
    2. L0: ``on_error`` 只能是 "raise"（拒绝 "log"——强一致不允许静默吞失效，
       否则 BLF-633 类 bug 会无声复现；A5 场景）。
    3. L1: ``on_error`` 强制 "log"（best_effort）；禁止 cascade / resource_id_from
       （L1 靠短 TTL 兜底，不做强一致级联）。
    4. cascade 层一致性（B3 场景）: L1 不能 cascade 进 L0——
       即 cascade 目标域不能是 L0 层（弱一致层写不能触发强一致层失效，
       否则强一致语义被 L1 的 best_effort 破坏）。
    5. project_id_from 必须是已知策略之一（path/query/payload/arg/global）。
    """
    domain_list = list(domains)
    if not domain_list:
        raise ValueError("domains 不能为空")

    for domain in domain_list:
        if domain not in REGISTERED_DOMAINS:
            raise KeyError(f"缓存域未登记: {domain!r}（请先加入 REGISTERED_DOMAINS）")

    source_layer = layer

    # 层约束
    if not celery:
        if layer == "L0":
            if on_error != "raise":
                raise ValueError(
                    f"L0 强一致层不允许 on_error={on_error!r}（只能 'raise'，"
                    "拒绝 'log'——静默吞失效 = BLF-633 类 bug 无声复现）"
                )
        elif layer == "L1":
            if on_error != "log":
                raise ValueError(
                    f"L1 弱一致层 on_error 强制 'log'（best_effort），不能是 {on_error!r}"
                )
            if cascade:
                raise ValueError("L1 弱一致层禁止 cascade（靠短 TTL 兜底）")
            if resource_id_from:
                raise ValueError("L1 弱一致层禁止 resource_id_from")
    else:
        # Celery 任务：on_error 可为 log（默认）或 raise；无 resource_id_from
        if on_error not in ("log", "raise"):
            raise ValueError(
                f"Celery 装饰器 on_error 只能是 'log'/'raise'，不能是 {on_error!r}"
            )
        if resource_id_from:
            raise ValueError("Celery 装饰器禁止 resource_id_from（按项目收敛即可）")

    # cascade 层一致性: 级联目标不能跨进更强一致层
    if cascade:
        for target in cascade:
            if target not in REGISTERED_DOMAINS:
                raise KeyError(
                    f"cascade 目标域未登记: {target!r}（请先加入 REGISTERED_DOMAINS）"
                )
            target_layer = REGISTERED_DOMAINS[target].layer
            if source_layer == "L1" and target_layer == "L0":
                raise ValueError(
                    f"L1 不能 cascade 进 L0 域 {target!r}（弱一致层写不能触发"
                    "强一致层失效，否则破坏 L0 强一致语义）"
                )

    # project_id_from 策略校验
    if project_id_from.split(":")[0] not in (
        "path",
        "query",
        "payload",
        "arg",
        "global",
    ):
        raise ValueError(f"未知 project_id_from 策略: {project_id_from!r}")


# ── L0 强一致装饰器 ───────────────────────────────────────────────────


def invalidate_cache_on_commit(
    *,
    domains: Iterable[str],
    project_id_from: str = "path",
    resource_id_from: str | None = None,
    cascade: Iterable[str] | None = (),
    on_error: Literal["raise"] = "raise",
) -> Callable[[Callable], Callable]:
    """L0 强一致写后失效装饰器（FastAPI 端点）。

    语义:
    - 端点正常返回（无异常）→ 立即失效声明的域；
    - 端点抛 HTTPException（4xx 校验失败）→ **跳过失效**（写未提交，A7 场景）；
    - 端点抛其他异常 → 不失效，异常向上传播；
    - 失效失败（on_error="raise"）→ 上抛（强一致可见性）。

    Args:
        domains: 要失效的缓存域（必须已登记）。
        project_id_from: 项目 ID 解析策略（"path"/"query"/"payload"/"arg"/"global"）。
        resource_id_from: 资源 ID 来源（如 "path:sku"），解析后传给失效函数。
        cascade: 级联失效的额外域（仅 L0 允许）。
        on_error: 失效失败策略（L0 只能 "raise"）。
    """
    _validate_decorator_args(
        layer="L0",
        domains=domains,
        project_id_from=project_id_from,
        on_error=on_error,
        cascade=cascade,
        resource_id_from=resource_id_from,
    )
    domain_list = list(domains)
    cascade_list = tuple(cascade or ())

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            # HTTPException / 其他异常在 func 内抛出 → 直接传播、不失效
            # （写未提交；A7 场景：HTTPException 跳过）。
            result = func(*args, **kwargs)
            try:
                project_ids = _resolve_project_ids(project_id_from, args, kwargs, func)
            except ValueError as exc:
                # 解析失败：L0 强一致宁可全量失效也不留旧值（A3 兜底语义）
                logger.warning(
                    "cache_decorator: %s project_id 解析失败，回退全量失效: %s",
                    func.__name__,
                    exc,
                )
                project_ids = [None]
            resource_id = _resolve_resource_id(resource_id_from, args, kwargs)
            _safe_invalidate(
                domain_list,
                project_ids,
                cascade=cascade_list,
                resource_id=resource_id,
                on_error=on_error,
                context=func.__name__,
            )
            return result

        return wrapper

    return decorator


# ── L1 弱一致装饰器 ───────────────────────────────────────────────────


def invalidate_cache_on_commit_l1(
    *,
    domains: Iterable[str],
    project_id_from: str = "path",
    on_error: Literal["log"] = "log",
) -> Callable[[Callable], Callable]:
    """L1 弱一致写后失效装饰器（best_effort，短 TTL 兜底）。

    与 L0 的区别:
    - ``on_error`` 永远 "log"（失效失败记 warning 继续，不阻断请求）；
    - 无 cascade、无 resource_id_from（设计 doc §5.2 / BLF-668）；
    - 仍保留 HTTPException 跳过语义（校验失败不失效）。
    """
    _validate_decorator_args(
        layer="L1",
        domains=domains,
        project_id_from=project_id_from,
        on_error=on_error,
        cascade=(),
        resource_id_from=None,
    )
    domain_list = list(domains)

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            result = func(*args, **kwargs)
            try:
                project_ids = _resolve_project_ids(project_id_from, args, kwargs, func)
            except ValueError as exc:
                logger.warning(
                    "cache_decorator: %s project_id 解析失败，回退全量失效: %s",
                    func.__name__,
                    exc,
                )
                project_ids = [None]
            _safe_invalidate(
                domain_list,
                project_ids,
                on_error="log",
                context=func.__name__,
            )
            return result

        return wrapper

    return decorator


# ── Celery 任务装饰器 ─────────────────────────────────────────────────


def invalidate_cache_on_commit_celery(
    *,
    domains: Iterable[str],
    project_id_from: str = "arg",
    cascade: Iterable[str] | None = (),
    on_error: Literal["log", "raise"] = "log",
) -> Callable[[Callable], Callable]:
    """Celery 任务写后失效装饰器（配合 mark_committed() 协议）。

    语义:
    - 任务正常返回且已 ``mark_committed()`` → 失效声明的域；
    - 任务抛异常 → **跳过失效**（A1 场景，异常传播）；
    - 任务正常返回但**未** mark_committed() → 记 warning、**跳过失效**
      （未确认 commit，A2 场景——协议约定 commit 后必须显式标记）；
    - project_id 解析失败 → 回退全量失效（A3 语义）。
    """
    _validate_decorator_args(
        layer="L1",  # Celery 按弱一致层约束（on_error 默认 log，可 raise）
        domains=domains,
        project_id_from=project_id_from,
        on_error=on_error,
        cascade=cascade,
        resource_id_from=None,
        celery=True,
    )
    domain_list = list(domains)
    cascade_list = tuple(cascade or ())

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            try:
                result = func(*args, **kwargs)
            except Exception:
                # A1：任务异常 → 不失效（写未提交），异常向上传播
                reset_committed()
                raise
            if not is_committed():
                # A2：正常返回但未 mark_committed → 协议违规，记 warning 跳过
                logger.warning(
                    "cache_decorator: Celery 任务 %s 未调用 mark_committed()，"
                    "跳过缓存失效（请确认 commit 后调用 mark_committed()）",
                    func.__name__,
                )
                return result
            try:
                project_ids = _resolve_project_ids(project_id_from, args, kwargs, func)
            except ValueError as exc:
                logger.warning(
                    "cache_decorator: Celery 任务 %s project_id 解析失败，"
                    "回退全量失效: %s",
                    func.__name__,
                    exc,
                )
                project_ids = [None]
            try:
                _safe_invalidate(
                    domain_list,
                    project_ids,
                    cascade=cascade_list,
                    on_error=on_error,
                    context=func.__name__,
                )
            finally:
                # 无论成败都清标记，避免污染调用栈外的后续任务
                reset_committed()
            return result

        return wrapper

    return decorator

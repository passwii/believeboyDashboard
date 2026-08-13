"""缓存治理基础设施：写后失效装饰器 + mark_committed 协议（BLF-665 子 #1）。

设计文档：``docs/superpowers/specs/2026-08-13-cache-governance-design.md``（§5-§7）

核心三件套：

- ``invalidate_cache_on_commit``          L0/L2 强一致装饰器（漏失效 = 测试 fail）
- ``invalidate_cache_on_commit_l1``       L1 弱一致装饰器（best_effort，短 TTL 兜底）
- ``invalidate_cache_on_commit_celery``   Celery 任务装饰器（mark_committed 协议）

配套协议：

- ``mark_committed()`` / ``reset_committed()`` / ``auto_commit(db)``
  Celery 任务在 ``db.commit()`` 成功后显式标记，装饰器在函数返回时统一失效。

铁律（§5.4）：
1. 每次 ``db.commit()`` 成功 → 调 ``mark_committed()``；
2. ``db.rollback()`` 或异常时**不要**调 ``mark_committed()``；
3. 多次 commit 可多次 mark，装饰器只在函数返回时失效一次。

project_id 解析（§5.5）：``path`` / ``query`` / ``payload`` / ``arg`` / ``global``。
解析失败（A3）→ 回退全量失效（fail-safe 偏向多失效）。
"""

from __future__ import annotations

import contextvars
import functools
import inspect
import logging
from typing import Any, Callable

from fastapi import HTTPException, Request

logger = logging.getLogger(__name__)

# ── 域注册表 ──────────────────────────────────────────────────────────
# 完整分层总表（§4）：10 L0 + 10 L1 + 2 L2。L3 基础设施独立维护，不在此表。

L0_DOMAINS: frozenset[str] = frozenset(
    {
        "inventory_replenishment",
        "data_management",
        "commission_records",
        "commission_ratio_overrides",
        "commission_role_assignments",
        "commission_summary",
        "platform_revenues",
        "crm",
        "operator_performance",
        "crm_tasks",
    }
)

L1_DOMAINS: frozenset[str] = frozenset(
    {
        "shipment_schedules",
        "inventory_analysis",
        "inventory_snapshot_options",
        "return_analysis",
        "sku_info",
        "report_reconciliation",
        "office",
        "product_analysis",
        "monthly_financial_series",
        "daily_analysis",
    }
)

L2_DOMAINS: frozenset[str] = frozenset({"ai_chat_v2", "ai_insight"})

# 层强度：L0(3) > L1(2) > L2(1)。用于 B3 层约束（cascade 目标不得强于源层）。
_LAYER_STRENGTH: dict[str, int] = (
    {d: 3 for d in L0_DOMAINS} | {d: 2 for d in L1_DOMAINS} | {d: 1 for d in L2_DOMAINS}
)

ALL_DOMAINS: frozenset[str] = L0_DOMAINS | L1_DOMAINS | L2_DOMAINS


# REGISTERED_DOMAINS 是集中登记表；invalidate_fn 由各域缓存模块（或测试 spy）
# 通过 ``register_invalidate_fn`` 注入。首版（子 #1）只登记域，不注入实现。
REGISTERED_DOMAINS: dict[str, dict[str, Any]] = {
    domain: {"invalidate_fn": None, "layer": _LAYER_STRENGTH[domain]}
    for domain in sorted(ALL_DOMAINS)
}


def register_invalidate_fn(domain: str, fn: Callable[..., Any]) -> None:
    """注入某域的失效函数（各域缓存模块在 import 时调用；测试可注入 spy）。

    fn 契约：``fn(project_id: int | None = None) -> int``（返回删除的 key 数）。
    不接受 project_id 的旧式全量失效函数（如 ``invalidate_platform_revenue_cache()``）
    也可注册——执行时会按签名自动降级为无参调用。
    """
    if domain not in REGISTERED_DOMAINS:
        raise KeyError(f"缓存域未注册: {domain!r}（见 REGISTERED_DOMAINS）")
    REGISTERED_DOMAINS[domain]["invalidate_fn"] = fn


# ── mark_committed 协议（§5.4）────────────────────────────────────────

_committed: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "cache_decorator_committed", default=False
)


def mark_committed() -> None:
    """Celery 协议：``db.commit()`` 成功后必须调用。装饰器在函数返回时读取。"""
    _committed.set(True)


def reset_committed() -> None:
    """清空 commit 标记（每次调用入口处执行，防 ContextVar 跨调用泄漏）。"""
    _committed.set(False)


def _was_committed() -> bool:
    return _committed.get(False)


class auto_commit:
    """context manager 一体化：``with auto_commit(db):`` 退出时自动 commit + mark。

    - 无异常 → ``db.commit()`` + ``mark_committed()``
    - 有异常 → ``db.rollback()``（不 mark，符合铁律 2）
    """

    def __init__(self, db: Any) -> None:
        self._db = db

    def __enter__(self) -> "auto_commit":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if exc_type is None:
            self._db.commit()
            mark_committed()
        else:
            try:
                self._db.rollback()
            except Exception:  # noqa: BLE001 - rollback 失败不掩盖原异常
                logger.warning("auto_commit rollback 失败", exc_info=True)
        return False


# ── project_id / resource_id 解析（§5.5）──────────────────────────────


def _find_request(args: tuple, kwargs: dict) -> Request | None:
    """在 args/kwargs 中定位 FastAPI Request 对象。"""
    for arg in args:
        if isinstance(arg, Request):
            return arg
    for value in kwargs.values():
        if isinstance(value, Request):
            return value
    return None


def _resolve_project_id(args: tuple, kwargs: dict, project_id_from: str) -> int | None:
    """按策略解析单个 project_id；无法解析返回 None（调用方决定是否全量失效）。"""
    if project_id_from == "global":
        return None

    if project_id_from == "path":
        # FastAPI 路径参数会以关键字参数注入；兜底从 request.path_params 取
        pid = kwargs.get("project_id")
        if pid is not None:
            return int(pid)
        request = _find_request(args, kwargs)
        if request is not None:
            raw = request.path_params.get("project_id")
            if raw is not None:
                return int(raw)
        return None

    if project_id_from == "query":
        request = _find_request(args, kwargs)
        if request is not None:
            raw = request.query_params.get("project_id")
            if raw is not None:
                return int(raw)
        return None

    if project_id_from == "payload":
        # 优先 kwargs['payload']；其次扫描 args/kwargs 中带 project_id 属性的模型
        payload = kwargs.get("payload")
        if payload is None:
            for arg in args:
                if hasattr(arg, "project_id"):
                    payload = arg
                    break
        if payload is None:
            for value in kwargs.values():
                if hasattr(value, "project_id"):
                    payload = value
                    break
        if payload is None:
            return None
        pid = getattr(payload, "project_id", None)
        return int(pid) if pid is not None else None

    if project_id_from == "arg":
        # Celery 任务：优先 kwargs['project_id']；其次扫描位置参数
        pid = kwargs.get("project_id")
        if pid is None:
            pid = next((a for a in args if isinstance(a, int)), None)
        return int(pid) if pid is not None else None

    raise ValueError(f"未知 project_id_from: {project_id_from!r}")


def _resolve_project_ids_all(
    args: tuple,
    kwargs: dict,
    project_id_from: str,
    extra_project_ids: Callable[[tuple, dict, Any], list[int]] | None,
    rv: Any,
) -> set[int] | None:
    """解析全部需失效的 project_id 集合。

    返回 ``None`` 表示全量失效（解析失败 / global 策略 / 结果为空时 fail-safe）。
    """
    if project_id_from == "global":
        return None
    project_ids: set[int] = set()
    try:
        pid = _resolve_project_id(args, kwargs, project_id_from)
        if pid is not None:
            project_ids.add(pid)
    except (TypeError, ValueError) as exc:
        # A3：project_id 解析失败 → 触发全量失效（fail-safe 偏向多失效）
        logger.warning(
            "缓存失效: project_id 解析失败(%s) %s，回退全量失效", project_id_from, exc
        )
        return None

    if extra_project_ids is not None:
        try:
            extra = extra_project_ids(args, kwargs, rv) or []
            project_ids.update(int(p) for p in extra)
        except Exception as exc:  # noqa: BLE001 - A6：回调挂掉不阻断主失效
            logger.error(
                "缓存失效: extra_project_ids 回调异常 %s（主 project_id 仍失效）", exc
            )

    return project_ids or None


def _resolve_resource_id(
    args: tuple, kwargs: dict, resource_id_from: str | None, rv: Any
) -> Any:
    """解析 resource_id（path:<key> / payload:<key> / row.id）。"""
    if not resource_id_from:
        return None
    if resource_id_from.startswith("path:"):
        key = resource_id_from.split(":", 1)[1]
        request = _find_request(args, kwargs)
        return request.path_params.get(key) if request is not None else None
    if resource_id_from.startswith("payload:"):
        key = resource_id_from.split(":", 1)[1]
        payload = kwargs.get("payload")
        return getattr(payload, key, None) if payload is not None else None
    if resource_id_from == "row.id":
        return getattr(rv, "id", None)
    return None


# ── 统一失效执行 ───────────────────────────────────────────────────────


def _fn_accepts_project_id(fn: Callable[..., Any]) -> bool:
    try:
        return "project_id" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return True  # 内置/不可内省函数，默认按接受处理


def _fn_accepts_resource_id(fn: Callable[..., Any]) -> bool:
    try:
        return "resource_id" in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def _safe_invalidate(
    domains: list[str],
    project_ids: set[int] | None,
    on_error: str,
    resource_id: Any = None,
) -> None:
    """对一组域执行失效。on_error='raise' 时失败上抛；'log' 时仅记录。

    - project_ids=None → 全量失效（fn() 无参 / fn(project_id=None)）
    - 域未注入 invalidate_fn → 按 on_error 处理（KeyError 或 warning）
    """
    for domain in domains:
        fn = REGISTERED_DOMAINS.get(domain, {}).get("invalidate_fn")
        if fn is None:
            msg = f"缓存域 {domain!r} 未注册 invalidate_fn（register_invalidate_fn）"
            if on_error == "raise":
                raise KeyError(msg)
            logger.warning("缓存失效跳过: %s", msg)
            continue

        try:
            if project_ids is None:
                if _fn_accepts_project_id(fn):
                    fn(project_id=None)
                else:
                    fn()
            else:
                for pid in project_ids:
                    if _fn_accepts_project_id(fn):
                        if _fn_accepts_resource_id(fn):
                            fn(project_id=pid, resource_id=resource_id)
                        else:
                            fn(project_id=pid)
                    else:
                        fn()  # 全量型失效函数（无 project_id 参数）
        except Exception as exc:  # noqa: BLE001
            if on_error == "raise":
                raise
            logger.warning("缓存域 %s 失效失败(best_effort): %s", domain, exc)


def _validate_decorator_args(
    *,
    domains: list[str],
    cascade: list[str] | None,
    on_error: str,
    kind: str,
) -> list[str]:
    """启动期校验（A4/A5/B3）：

    - 所有域（含 cascade 目标）必须已在 REGISTERED_DOMAINS 登记（A4/A8 KeyError）
    - L0/L2 拒绝 on_error='log'（A5 ValueError）
    - cascade 目标层不得强于源层（B3：L1 不能 cascade 进 L0）
    """
    all_domains = [*domains, *(cascade or [])]
    for domain in all_domains:
        if domain not in REGISTERED_DOMAINS:
            raise KeyError(
                f"缓存域未注册: {domain!r}（typo 检查；见 REGISTERED_DOMAINS）"
            )

    source_strength = min(_LAYER_STRENGTH[d] for d in domains)
    for target in cascade or []:
        if _LAYER_STRENGTH[target] > source_strength:
            raise ValueError(
                f"cascade 层约束: {target!r}（L{_LAYER_STRENGTH[target]}）"
                f"强于源层 {domains[0]!r}（L{source_strength}）——"
                "弱层级联进强层不允许（B3）"
            )

    if kind in ("l0", "l2") and on_error == "log":
        raise ValueError("L0/L2 域不允许 on_error='log'（强一致必须 raise，A5）")
    if kind == "l1" and on_error != "log":
        raise ValueError("L1 域必须 on_error='log'（best_effort，短 TTL 兜底）")
    return all_domains


def _run_invalidation(
    args: tuple,
    kwargs: dict,
    rv: Any,
    *,
    all_domains: list[str],
    project_id_from: str,
    resource_id_from: str | None,
    extra_project_ids: Callable[[tuple, dict, Any], list[int]] | None,
    on_error: str,
) -> None:
    project_ids = _resolve_project_ids_all(
        args, kwargs, project_id_from, extra_project_ids, rv
    )
    resource_id = _resolve_resource_id(args, kwargs, resource_id_from, rv)
    _safe_invalidate(all_domains, project_ids, on_error, resource_id=resource_id)


# ── 装饰器三件套 ───────────────────────────────────────────────────────


def invalidate_cache_on_commit(
    *,
    domains: list[str],
    cascade: list[str] | None = None,
    project_id_from: str = "path",
    resource_id_from: str | None = None,
    extra_project_ids: Callable[[tuple, dict, Any], list[int]] | None = None,
    on_error: str = "raise",
) -> Callable:
    """L0/L2 强一致装饰器：函数成功返回后强制失效（漏失效 = 测试 fail）。

    规则：
    - 函数抛异常（含 FastAPI HTTPException，A7）→ 不失效（fail-safe，A1）
    - 成功返回 → 统一失效（含 cascade 域）
    - project_id 解析失败 → 全量失效（A3）
    """
    all_domains = _validate_decorator_args(
        domains=domains, cascade=cascade, on_error=on_error, kind="l0"
    )

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                try:
                    rv = await fn(*args, **kwargs)
                except HTTPException:
                    raise  # A7：4xx 不失效
                except Exception:
                    raise  # A1：fail-safe，异常不失效
                _run_invalidation(
                    args,
                    kwargs,
                    rv,
                    all_domains=all_domains,
                    project_id_from=project_id_from,
                    resource_id_from=resource_id_from,
                    extra_project_ids=extra_project_ids,
                    on_error=on_error,
                )
                return rv

            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                rv = fn(*args, **kwargs)
            except HTTPException:
                raise  # A7：4xx 不失效
            except Exception:
                raise  # A1：fail-safe，异常不失效
            _run_invalidation(
                args,
                kwargs,
                rv,
                all_domains=all_domains,
                project_id_from=project_id_from,
                resource_id_from=resource_id_from,
                extra_project_ids=extra_project_ids,
                on_error=on_error,
            )
            return rv

        return wrapper

    return decorator


def invalidate_cache_on_commit_l1(
    *,
    domains: list[str],
    project_id_from: str = "path",
    extra_project_ids: Callable[[tuple, dict, Any], list[int]] | None = None,
) -> Callable:
    """L1 弱一致装饰器：失效失败 best_effort（log），短 TTL 自动兜底。

    无 cascade、无 resource_id_from（设计 §5.2）。
    """
    all_domains = _validate_decorator_args(
        domains=domains, cascade=None, on_error="log", kind="l1"
    )

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                try:
                    rv = await fn(*args, **kwargs)
                except HTTPException:
                    raise
                except Exception:
                    raise
                _run_invalidation(
                    args,
                    kwargs,
                    rv,
                    all_domains=all_domains,
                    project_id_from=project_id_from,
                    resource_id_from=None,
                    extra_project_ids=extra_project_ids,
                    on_error="log",
                )
                return rv

            return async_wrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                rv = fn(*args, **kwargs)
            except HTTPException:
                raise
            except Exception:
                raise
            _run_invalidation(
                args,
                kwargs,
                rv,
                all_domains=all_domains,
                project_id_from=project_id_from,
                resource_id_from=None,
                extra_project_ids=extra_project_ids,
                on_error="log",
            )
            return rv

        return wrapper

    return decorator


def invalidate_cache_on_commit_celery(
    *,
    domains: list[str],
    cascade: list[str] | None = None,
    project_id_from: str = "arg",
    extra_project_ids: Callable[[tuple, dict, Any], list[int]] | None = None,
    on_error: str = "log",
) -> Callable:
    """Celery 任务装饰器：依赖 mark_committed() 协议，函数返回时统一失效。

    规则：
    - 函数异常（A1）→ 不失效（fail-safe）
    - 成功返回但未调 mark_committed()（A2）→ log warning，不失效（提醒漏 mark）
    - 成功返回且已 mark → 统一失效（on_error 默认 log，best_effort）
    """
    all_domains = _validate_decorator_args(
        domains=domains, cascade=cascade, on_error=on_error, kind="celery"
    )

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            reset_committed()  # 每次调用入口清标记，防 ContextVar 泄漏
            try:
                rv = fn(*args, **kwargs)
            except Exception:
                raise  # A1：fail-safe，异常不失效
            if not _was_committed():
                # A2：未 mark → 说明业务漏调 mark_committed（或根本没 commit）
                logger.warning(
                    "Celery 任务 %s 成功但未调用 mark_committed()——缓存未失效，"
                    "等待 TTL 兜底（A2）",
                    getattr(fn, "__name__", str(fn)),
                )
                return rv
            _run_invalidation(
                args,
                kwargs,
                rv,
                all_domains=all_domains,
                project_id_from=project_id_from,
                resource_id_from=None,
                extra_project_ids=extra_project_ids,
                on_error=on_error,
            )
            return rv

        return wrapper

    return decorator

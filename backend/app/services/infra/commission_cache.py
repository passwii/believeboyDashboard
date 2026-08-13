"""Commission 域缓存层（BLF-665 子 #2 阶段 2-A）。

为 L0 的 4 个 commission 域（records / ratio_overrides / role_assignments / summary）
提供 get/set/invalidate 三件套。commission 数据以 report_month（+ country）为
读维度，缓存 key 以月为粒度；写路径（upsert / recompute）通过
``invalidate_cache_on_commit`` 装饰器触发整域失效（月粒度数据写后整域清空是
正确且安全的——写入频率低、数据量小）。

设计 §4.1：#3 commission_records、#4 commission_ratio_overrides、
#5 commission_role_assignments、#6 commission_summary。
"""

from __future__ import annotations

import hashlib

from app.services.infra.cache import cache_delete_pattern, cache_get, cache_set
from app.services.infra.cache_decorator import register_invalidate_fn
from app.services.infra.redis import _p

COMMISSION_RECORDS_KEY_PREFIX = _p("cache:commission:records")
COMMISSION_RATIO_OVERRIDES_KEY_PREFIX = _p("cache:commission:ratio-overrides")
COMMISSION_ROLE_ASSIGNMENTS_KEY_PREFIX = _p("cache:commission:role-assignments")
COMMISSION_SUMMARY_KEY_PREFIX = _p("cache:commission:summary")

COMMISSION_TTL = 4 * 3600  # L0：4h 长 TTL（设计 §4.1）


def _hash(*parts: str) -> str:
    raw = ":".join(str(p) for p in parts)
    return hashlib.md5(raw.encode()).hexdigest()[:16]


# ── commission_records（业绩明细）──────────────────────────────────────


def get_commission_records_cache(
    report_month: str,
    country: str,
    person_name: str | None,
    include_inactive: bool,
) -> dict | None:
    key = (
        f"{COMMISSION_RECORDS_KEY_PREFIX}:month:{report_month}:country:{country}:"
        f"person:{person_name or ''}:inactive:{include_inactive}"
    )
    return cache_get(key)


def set_commission_records_cache(
    report_month: str,
    country: str,
    person_name: str | None,
    include_inactive: bool,
    data: dict,
) -> None:
    key = (
        f"{COMMISSION_RECORDS_KEY_PREFIX}:month:{report_month}:country:{country}:"
        f"person:{person_name or ''}:inactive:{include_inactive}"
    )
    cache_set(key, data, COMMISSION_TTL)


def invalidate_commission_records_cache(project_id: int | None = None) -> int:
    """整域失效（月粒度数据，写后清空全部月份）。project_id 参数仅为兼容装饰器契约。"""
    return cache_delete_pattern(f"{COMMISSION_RECORDS_KEY_PREFIX}:*")


# ── commission_ratio_overrides（业绩比例）──────────────────────────────


def get_commission_ratio_overrides_cache(report_month: str) -> dict | None:
    key = f"{COMMISSION_RATIO_OVERRIDES_KEY_PREFIX}:month:{report_month}"
    return cache_get(key)


def set_commission_ratio_overrides_cache(report_month: str, data: dict) -> None:
    key = f"{COMMISSION_RATIO_OVERRIDES_KEY_PREFIX}:month:{report_month}"
    cache_set(key, data, COMMISSION_TTL)


def invalidate_commission_ratio_overrides_cache(
    project_id: int | None = None,
) -> int:
    return cache_delete_pattern(f"{COMMISSION_RATIO_OVERRIDES_KEY_PREFIX}:*")


# ── commission_role_assignments（角色分配）─────────────────────────────


def get_commission_role_assignments_cache(
    project_id: int | None, report_month: str | None
) -> dict | None:
    key = (
        f"{COMMISSION_ROLE_ASSIGNMENTS_KEY_PREFIX}:"
        f"project:{project_id or 'all'}:month:{report_month or 'all'}"
    )
    return cache_get(key)


def set_commission_role_assignments_cache(
    project_id: int | None, report_month: str | None, data: dict
) -> None:
    key = (
        f"{COMMISSION_ROLE_ASSIGNMENTS_KEY_PREFIX}:"
        f"project:{project_id or 'all'}:month:{report_month or 'all'}"
    )
    cache_set(key, data, COMMISSION_TTL)


def invalidate_commission_role_assignments_cache(
    project_id: int | None = None,
) -> int:
    if project_id:
        return cache_delete_pattern(
            f"{COMMISSION_ROLE_ASSIGNMENTS_KEY_PREFIX}:project:{project_id}:*"
        )
    return cache_delete_pattern(f"{COMMISSION_ROLE_ASSIGNMENTS_KEY_PREFIX}:*")


# ── commission_summary（业绩汇总）──────────────────────────────────────


def get_commission_summary_cache(
    kind: str, year: str, country: str | None
) -> dict | None:
    key = (
        f"{COMMISSION_SUMMARY_KEY_PREFIX}:{kind}:year:{year}:country:{country or 'all'}"
    )
    return cache_get(key)


def set_commission_summary_cache(
    kind: str, year: str, country: str | None, data: dict
) -> None:
    key = (
        f"{COMMISSION_SUMMARY_KEY_PREFIX}:{kind}:year:{year}:country:{country or 'all'}"
    )
    cache_set(key, data, COMMISSION_TTL)


def invalidate_commission_summary_cache(project_id: int | None = None) -> int:
    return cache_delete_pattern(f"{COMMISSION_SUMMARY_KEY_PREFIX}:*")


# ── 域注册（供装饰器契约使用）─────────────────────────────────────────

register_invalidate_fn("commission_records", invalidate_commission_records_cache)
register_invalidate_fn(
    "commission_ratio_overrides", invalidate_commission_ratio_overrides_cache
)
register_invalidate_fn(
    "commission_role_assignments", invalidate_commission_role_assignments_cache
)
register_invalidate_fn("commission_summary", invalidate_commission_summary_cache)

# operator_performance：L0 级联目标（commission_records/roles 写时 cascade）。
# 无独立缓存层（设计 §4.1 #9）——失效 fn 清空其前缀即可，未写入则 no-op。
OPERATOR_PERFORMANCE_KEY_PREFIX = _p("cache:operator-performance")


def invalidate_operator_performance_cache(project_id: int | None = None) -> int:
    if project_id:
        return cache_delete_pattern(
            f"{OPERATOR_PERFORMANCE_KEY_PREFIX}:project:{project_id}:*"
        )
    return cache_delete_pattern(f"{OPERATOR_PERFORMANCE_KEY_PREFIX}:*")


register_invalidate_fn("operator_performance", invalidate_operator_performance_cache)

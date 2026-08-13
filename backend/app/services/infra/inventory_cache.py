"""Inventory analysis & replenishment cache (Redis-backed).

TTL 策略:
- inventory-analysis: 5 min — 库存数据由快照上传触发变更，频率低
- inventory-snapshot-options: 10 min — 选项列表变更更少
- inventory-replenishment-analysis: 5 min — 与 inventory-analysis 同源
- return-analysis: 5 min — 退货数据 T+1 同步
- platform-revenues: 5 min — 财务数据手动录入，变更频率极低
- sku-info: 5 min — SKU 主数据编辑/同步后主动失效
"""

import hashlib

from app.services.infra.cache import cache_delete_pattern, cache_get, cache_set
from app.services.infra.cache_decorator import register_invalidate_fn
from app.services.infra.redis import _p

# ── TTL constants ─────────────────────────────────────────────────────
INVENTORY_ANALYSIS_TTL = 300  # 5 minutes
INVENTORY_SNAPSHOT_OPTIONS_TTL = 600  # 10 minutes
INVENTORY_REPLENISHMENT_TTL = 300  # 5 minutes
RETURN_ANALYSIS_TTL = 300  # 5 minutes
PLATFORM_REVENUE_TTL = 300  # 5 minutes
SKU_INFO_TTL = 300  # 5 minutes

# ── Key prefixes ──────────────────────────────────────────────────────
INVENTORY_ANALYSIS_KEY_PREFIX = _p("cache:inventory-analysis")
INVENTORY_SNAPSHOT_OPTIONS_KEY_PREFIX = _p("cache:inventory-snapshot-options")
INVENTORY_REPLENISHMENT_KEY_PREFIX = _p("cache:inventory-replenishment")
RETURN_ANALYSIS_KEY_PREFIX = _p("cache:return-analysis:v1")
# BEL-373: v2 prefix for snapshot-or-fallback dual-path endpoint.
# - v1 key still kept so old in-flight caches (5 min TTL) drain naturally.
# - v2 includes a "source" segment so we can tell snapshot vs fallback responses
#   apart in redis-monitor (debugging aid; cheap).
RETURN_ANALYSIS_V2_KEY_PREFIX = _p("cache:return-analysis:v2")
PLATFORM_REVENUE_KEY_PREFIX = _p("cache:platform-revenues")
SKU_INFO_KEY_PREFIX = _p("cache:sku-info")


def _hash_params(*parts: str) -> str:
    """Hash variable-length params into a stable 16-char key segment."""
    raw = ":".join(str(p) for p in parts)
    return hashlib.md5(raw.encode()).hexdigest()[:16]


# ── Inventory Analysis ────────────────────────────────────────────────


def get_inventory_analysis_cache(
    project_id: int,
    country: str,
    report_date: str | None,
) -> dict | None:
    key = f"{INVENTORY_ANALYSIS_KEY_PREFIX}:project:{project_id}:country:{country}:date:{report_date or 'current'}"
    return cache_get(key)


def set_inventory_analysis_cache(
    project_id: int,
    country: str,
    report_date: str | None,
    data: dict,
) -> None:
    key = f"{INVENTORY_ANALYSIS_KEY_PREFIX}:project:{project_id}:country:{country}:date:{report_date or 'current'}"
    cache_set(key, data, INVENTORY_ANALYSIS_TTL)


def invalidate_inventory_analysis_cache(project_id: int | None = None) -> int:
    if project_id:
        pattern = f"{INVENTORY_ANALYSIS_KEY_PREFIX}:project:{project_id}:*"
    else:
        pattern = f"{INVENTORY_ANALYSIS_KEY_PREFIX}:*"
    return cache_delete_pattern(pattern)


# ── Inventory Snapshot Options ────────────────────────────────────────


def get_inventory_snapshot_options_cache(
    project_id: int,
    country: str,
) -> list | None:
    key = f"{INVENTORY_SNAPSHOT_OPTIONS_KEY_PREFIX}:project:{project_id}:country:{country}"
    return cache_get(key)


def set_inventory_snapshot_options_cache(
    project_id: int,
    country: str,
    data: list,
) -> None:
    key = f"{INVENTORY_SNAPSHOT_OPTIONS_KEY_PREFIX}:project:{project_id}:country:{country}"
    cache_set(key, data, INVENTORY_SNAPSHOT_OPTIONS_TTL)


def invalidate_inventory_snapshot_options_cache(project_id: int | None = None) -> int:
    if project_id:
        pattern = f"{INVENTORY_SNAPSHOT_OPTIONS_KEY_PREFIX}:project:{project_id}:*"
    else:
        pattern = f"{INVENTORY_SNAPSHOT_OPTIONS_KEY_PREFIX}:*"
    return cache_delete_pattern(pattern)


# ── Inventory Replenishment Analysis ─────────────────────────────────


def get_inventory_replenishment_cache(
    project_id: int,
    country: str,
    keyword: str | None,
    risk_status: str | None,
    in_transit_only: bool,
    page: int,
    page_size: int,
    *,
    inventory_state: str | None = None,
    replenishment_action: str | None = None,
    order_by: str | None = None,
    order_dir: str = "asc",
    detail: str = "full",
    report_date: str | None = None,
) -> dict | None:
    params_hash = _hash_params(
        str(project_id),
        country,
        keyword or "",
        risk_status or "",
        str(in_transit_only),
        str(page),
        str(page_size),
        # BLF-502 D10: 新参数全部进 key（过滤/排序/detail/report_date）
        inventory_state or "",
        replenishment_action or "",
        order_by or "",
        order_dir,
        detail,
        report_date or "",
    )
    # BLF-633: key 带 project 段，使失效可项目级收敛（不再全量清空）
    key = f"{INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:{project_id}:{params_hash}"
    return cache_get(key)


def set_inventory_replenishment_cache(
    project_id: int,
    country: str,
    keyword: str | None,
    risk_status: str | None,
    in_transit_only: bool,
    page: int,
    page_size: int,
    data: dict,
    *,
    inventory_state: str | None = None,
    replenishment_action: str | None = None,
    order_by: str | None = None,
    order_dir: str = "asc",
    detail: str = "full",
    report_date: str | None = None,
) -> None:
    params_hash = _hash_params(
        str(project_id),
        country,
        keyword or "",
        risk_status or "",
        str(in_transit_only),
        str(page),
        str(page_size),
        inventory_state or "",
        replenishment_action or "",
        order_by or "",
        order_dir,
        detail,
        report_date or "",
    )
    key = f"{INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:{project_id}:{params_hash}"
    cache_set(key, data, INVENTORY_REPLENISHMENT_TTL)


def invalidate_inventory_replenishment_cache(project_id: int | None = None) -> int:
    """Invalidate replenishment analysis cache, optionally scoped to one project.

    Keys carry a ``project:{id}`` segment (BLF-633), so passing ``project_id``
    only clears that project's entries; ``None`` clears all.
    """
    if project_id:
        pattern = f"{INVENTORY_REPLENISHMENT_KEY_PREFIX}:project:{project_id}:*"
    else:
        pattern = f"{INVENTORY_REPLENISHMENT_KEY_PREFIX}:*"
    return cache_delete_pattern(pattern)


# ── Return Analysis ───────────────────────────────────────────────────


def get_return_analysis_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
) -> dict | None:
    key = (
        f"{RETURN_ANALYSIS_KEY_PREFIX}:project:{project_id}:country:{country}"
        f":start:{start_date}:end:{end_date}:sku:{sku or 'all'}"
    )
    return cache_get(key)


def set_return_analysis_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
    data: dict,
) -> None:
    key = (
        f"{RETURN_ANALYSIS_KEY_PREFIX}:project:{project_id}:country:{country}"
        f":start:{start_date}:end:{end_date}:sku:{sku or 'all'}"
    )
    cache_set(key, data, RETURN_ANALYSIS_TTL)


def invalidate_return_analysis_cache(project_id: int | None = None) -> int:
    if project_id:
        pattern = f"{RETURN_ANALYSIS_KEY_PREFIX}:project:{project_id}:*"
    else:
        pattern = f"{RETURN_ANALYSIS_KEY_PREFIX}:*"
    return cache_delete_pattern(pattern)


# ── Return Analysis v2 (BEL-373 snapshot-or-fallback) ────────────────


def get_return_analysis_v2_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
) -> dict | None:
    """v2 缓存键（包含 source 段以便 redis-monitor 区分路径）.

    返回值带 ``_cache_source`` 字段, 值为 ``snapshot`` 或 ``fallback``.
    调用方应忽略该字段, 直接喂给 ReturnAnalysisResponse.
    """
    key = (
        f"{RETURN_ANALYSIS_V2_KEY_PREFIX}:project:{project_id}:country:{country}"
        f":start:{start_date}:end:{end_date}:sku:{sku or 'all'}"
    )
    return cache_get(key)


def set_return_analysis_v2_cache(
    project_id: int,
    country: str,
    start_date: str,
    end_date: str,
    sku: str | None,
    data: dict,
    source: str,
) -> None:
    """v2 写缓存, ``source`` 是 ``snapshot`` / ``fallback`` 二选一."""
    payload = dict(data)
    payload["_cache_source"] = source
    key = (
        f"{RETURN_ANALYSIS_V2_KEY_PREFIX}:project:{project_id}:country:{country}"
        f":start:{start_date}:end:{end_date}:sku:{sku or 'all'}"
    )
    cache_set(key, payload, RETURN_ANALYSIS_TTL)


def invalidate_return_analysis_v2_cache(project_id: int | None = None) -> int:
    if project_id:
        pattern = f"{RETURN_ANALYSIS_V2_KEY_PREFIX}:project:{project_id}:*"
    else:
        pattern = f"{RETURN_ANALYSIS_V2_KEY_PREFIX}:*"
    return cache_delete_pattern(pattern)


# ── Platform Revenues ─────────────────────────────────────────────────


def get_platform_revenue_cache(
    project_id: int | None,
    year: int | None,
    month: int | None,
    country: str | None,
    currency: str | None,
    page: int,
    page_size: int,
    operator: str | None,
) -> dict | None:
    params_hash = _hash_params(
        str(project_id or "all"),
        str(year or "all"),
        str(month or "all"),
        country or "all",
        currency or "all",
        str(page),
        str(page_size),
        operator or "all",
    )
    key = f"{PLATFORM_REVENUE_KEY_PREFIX}:{params_hash}"
    return cache_get(key)


def set_platform_revenue_cache(
    project_id: int | None,
    year: int | None,
    month: int | None,
    country: str | None,
    currency: str | None,
    page: int,
    page_size: int,
    operator: str | None,
    data: dict,
) -> None:
    params_hash = _hash_params(
        str(project_id or "all"),
        str(year or "all"),
        str(month or "all"),
        country or "all",
        currency or "all",
        str(page),
        str(page_size),
        operator or "all",
    )
    key = f"{PLATFORM_REVENUE_KEY_PREFIX}:{params_hash}"
    cache_set(key, data, PLATFORM_REVENUE_TTL)


def invalidate_platform_revenue_cache() -> int:
    return cache_delete_pattern(f"{PLATFORM_REVENUE_KEY_PREFIX}:*")


# ── SKU Info ──────────────────────────────────────────────────────────


def get_sku_info_cache(
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    country: str | None,
    is_active: bool | None,
    page: int,
    page_size: int,
    managed_project_ids: list[int] | None,
) -> dict | None:
    ids_str = (
        ",".join(str(i) for i in sorted(managed_project_ids))
        if managed_project_ids
        else "all"
    )
    params_hash = _hash_params(
        project_name or "",
        sku or "",
        asin or "",
        country or "",
        str(is_active) if is_active is not None else "none",
        str(page),
        str(page_size),
        ids_str,
    )
    key = f"{SKU_INFO_KEY_PREFIX}:{params_hash}"
    return cache_get(key)


def set_sku_info_cache(
    project_name: str | None,
    sku: str | None,
    asin: str | None,
    country: str | None,
    is_active: bool | None,
    page: int,
    page_size: int,
    managed_project_ids: list[int] | None,
    data: dict,
) -> None:
    ids_str = (
        ",".join(str(i) for i in sorted(managed_project_ids))
        if managed_project_ids
        else "all"
    )
    params_hash = _hash_params(
        project_name or "",
        sku or "",
        asin or "",
        country or "",
        str(is_active) if is_active is not None else "none",
        str(page),
        str(page_size),
        ids_str,
    )
    key = f"{SKU_INFO_KEY_PREFIX}:{params_hash}"
    cache_set(key, data, SKU_INFO_TTL)


def invalidate_sku_info_cache() -> int:
    return cache_delete_pattern(f"{SKU_INFO_KEY_PREFIX}:*")


# ── 域注册（供装饰器契约使用，BLF-665 子 #2）────────────────────────────
register_invalidate_fn("inventory_analysis", invalidate_inventory_analysis_cache)
register_invalidate_fn(
    "inventory_snapshot_options", invalidate_inventory_snapshot_options_cache
)
register_invalidate_fn(
    "inventory_replenishment", invalidate_inventory_replenishment_cache
)


def _invalidate_return_analysis_dual(project_id: int | None = None) -> int:
    """BLF-668: v1+v2 双清（退货分析既有两套前缀）。"""
    return invalidate_return_analysis_cache(
        project_id
    ) + invalidate_return_analysis_v2_cache(project_id)


register_invalidate_fn("return_analysis", _invalidate_return_analysis_dual)
register_invalidate_fn("platform_revenues", invalidate_platform_revenue_cache)
register_invalidate_fn("sku_info", invalidate_sku_info_cache)

"""Inventory replenishment service.

Business logic for inventory replenishment analysis.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any
import warnings

from fastapi import HTTPException, status
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisSalesOrderRow,
    AnalysisBusinessRow,
    AnalysisSourceFile,
    InventoryReplenishmentSetting,
    InventorySnapshotRow,
    SkuRecord,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.services.sales_query import counted_sales_where
from app.services.inventory.health_score import ItemInput
from app.services.inventory.seasonal_factor import compute_seasonal_factor
from app.services.inventory.state_action import (
    EMERGENCY_ORDER_BUFFER_DAYS,
    compute_inventory_state,
    compute_replenishment_action,
    compute_seasonal_adjusted_sellable_days,
    compute_signals,
    compute_trend_label,
    compute_trend_momentum,
)
from app.schemas.inventory_replenishment import InventorySignals

from app.utils.text_utils import normalize_text, normalize_asin
from app.utils.math_utils import decimal_to_float, round_decimal, round_decimal_to_int
from app.utils.constants import (
    DEFAULT_PRODUCTION_LEAD_DAYS,
    DEFAULT_SHIPPING_DAYS,
    DEFAULT_SAFETY_FACTOR,
    RECENT_SALES_LAG_DAYS,
    RECENT_SALES_WINDOW_DAYS,
)
from app.utils.country import normalize_country

IN_TRANSIT_STATUSES = ("in_transit", "draft")
RISK_LONG_TERM_OUT_OF_STOCK = "长期断货"
RISK_SHORT_TERM_OUT_OF_STOCK = "短期断货"
RISK_OUT_OF_STOCK = "断货风险"
RISK_HEALTHY = "健康库存"
RISK_SLOW_MOVING = "滞销"
RISK_SEVERE_SLOW_MOVING = "严重滞销"
RISK_PENDING = "待补数据"

# BLF-630 二轮: 目标覆盖天数默认值（补货量动态化基准；可进 settings 表按 SKU 覆盖）
DEFAULT_TARGET_DAYS = 90

# BLF-502: 三段式取值全集（summary 分布 / Agent 过滤白名单用）
STATE_VALUES = ("critical", "deteriorating", "watch", "healthy", "unknown")
ACTION_VALUES = (
    "REPLENISH_NOW",
    "REPLENISH_NORMAL",
    "HOLD",
    "REDUCE_PRICE",
    "REMOVE",
    "NO_ACTION",
)

# BLF-502: R1 order_by 白名单（Agent 排序用；实现时在白名单外忽略）
REPLENISHMENT_ORDER_BY_FIELDS = (
    "sku",
    "available_inventory",
    "in_transit_quantity",
    "weighted_dms",
    "sellable_days",
    "estimated_replenishment_quantity",
    "risk_status",
    "inventory_state",
    "replenishment_action",
    # BLF-630: 补货周期/覆盖时间线字段（int / ISO date 可排序）
    "order_buffer_days",
    "coverage_end_date",
)


@dataclass
class _BaseSkuRow:
    sku: str
    asin: str | None
    country: str


@dataclass
class _InventorySnapshot:
    """Age-bucket snapshot from ``InventorySnapshotRow``, keyed by SKU."""

    available_qty: int = 0
    age_0_90_qty: int = 0
    age_91_180_qty: int = 0
    age_181_270_qty: int = 0
    age_271_365_qty: int = 0
    age_365_plus_qty: int = 0
    recommended_action: str | None = None


@dataclass
class _TransitBatch:
    """在途批次（BLF-630）：保留到货日期字段，供覆盖时间线计算。

    eta 解析兜底链（spec §4.8）：eta_date → etd_date + shipping_days
    → created_date + shipping_days（在 ``_compute_coverage_timeline`` 中解析）。
    """

    quantity: int = 0
    eta_date: date | None = None
    etd_date: date | None = None
    created_date: date | None = None


def _normalize_text(value: str | None, *, max_length: int | None = None) -> str | None:
    warnings.warn(
        "_normalize_text is deprecated, use app.shared.text_utils.normalize_text instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return normalize_text(value, max_length=max_length)


def _decimal_to_float(value: Decimal | None, digits: int = 4) -> float | None:
    warnings.warn(
        "_decimal_to_float is deprecated, use app.shared.math_utils.decimal_to_float instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return decimal_to_float(value, digits=digits)


def _round_decimal(value: Decimal, digits: int = 4) -> Decimal:
    warnings.warn(
        "_round_decimal is deprecated, use app.shared.math_utils.round_decimal instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return round_decimal(value, digits=digits)


def _round_decimal_to_int(value: Decimal) -> int:
    warnings.warn(
        "_round_decimal_to_int is deprecated, use app.shared.math_utils.round_decimal_to_int instead",
        DeprecationWarning,
        stacklevel=2,
    )
    return round_decimal_to_int(value)


def _get_project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def _pick_business_source(
    db: Session, project_id: int, country: str, target_days: int, today: date
) -> AnalysisSourceFile | None:
    rows = (
        db.execute(
            select(AnalysisSourceFile)
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "business_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
                AnalysisSourceFile.period_start_date.is_not(None),
                AnalysisSourceFile.period_end_date.is_not(None),
                AnalysisSourceFile.period_end_date <= today,
            )
            .order_by(
                AnalysisSourceFile.period_end_date.desc(), AnalysisSourceFile.id.desc()
            )
        )
        .scalars()
        .all()
    )

    best_row: AnalysisSourceFile | None = None
    best_score: tuple[int, int] | None = None
    for row in rows:
        assert row.period_start_date is not None
        assert row.period_end_date is not None
        span_days = (row.period_end_date - row.period_start_date).days + 1
        score = (abs(span_days - target_days), abs((today - row.period_end_date).days))
        if best_score is None or score < best_score:
            best_row = row
            best_score = score
    return best_row


def _load_base_skus(db: Session, project: Project, country: str) -> list[_BaseSkuRow]:
    normalized_project_name = normalize_text(project.project_name, max_length=128)
    product_rows = db.execute(
        select(SkuRecord.sku, SkuRecord.asin, SkuRecord.country)
        .where(
            func.lower(func.trim(SkuRecord.project_name)) == normalized_project_name,
            SkuRecord.is_active.is_(True),
            SkuRecord.country == country,
        )
        .order_by(SkuRecord.sort_order.asc(), SkuRecord.id.asc())
    ).all()
    setting_rows = db.execute(
        select(
            InventoryReplenishmentSetting.sku,
            InventoryReplenishmentSetting.asin,
            InventoryReplenishmentSetting.country,
        )
        .where(
            InventoryReplenishmentSetting.project_id == project.id,
            InventoryReplenishmentSetting.country == country,
        )
        .order_by(InventoryReplenishmentSetting.id.asc())
    ).all()

    merged: dict[tuple[str, str], _BaseSkuRow] = {}
    for sku, asin, row_country in [*product_rows, *setting_rows]:
        normalized_sku = _normalize_text(sku, max_length=128)
        if normalized_sku is None:
            continue
        normalized_country = normalize_country(row_country)
        current = merged.get((normalized_sku, normalized_country))
        normalized_asin = _normalize_text(asin, max_length=64)
        if current is None:
            merged[(normalized_sku, normalized_country)] = _BaseSkuRow(
                sku=normalized_sku,
                asin=normalized_asin,
                country=normalized_country,
            )
            continue
        if current.asin is None and normalized_asin is not None:
            current.asin = normalized_asin
    return list(merged.values())


def _load_settings_map(
    db: Session, project_id: int, country: str
) -> dict[tuple[str, str], InventoryReplenishmentSetting]:
    rows = (
        db.execute(
            select(InventoryReplenishmentSetting).where(
                InventoryReplenishmentSetting.project_id == project_id,
                InventoryReplenishmentSetting.country == country,
            )
        )
        .scalars()
        .all()
    )
    return {(row.sku, row.country): row for row in rows}


def _load_inventory_map(
    db: Session, project_id: int, country: str, report_date: date | None = None
) -> dict[str, _InventorySnapshot]:
    from app.services.inventory_analysis_service import _get_inventory_source

    source = _get_inventory_source(
        db,
        project_id=project_id,
        country=country,
        report_date=report_date,
    )
    if source is None:
        return {}
    rows = db.execute(
        select(
            InventorySnapshotRow.sku,
            func.coalesce(func.sum(InventorySnapshotRow.available_qty), 0).label(
                "available_qty"
            ),
            func.coalesce(func.sum(InventorySnapshotRow.age_0_90_qty), 0).label(
                "age_0_90_qty"
            ),
            func.coalesce(func.sum(InventorySnapshotRow.age_91_180_qty), 0).label(
                "age_91_180_qty"
            ),
            func.coalesce(func.sum(InventorySnapshotRow.age_181_270_qty), 0).label(
                "age_181_270_qty"
            ),
            func.coalesce(func.sum(InventorySnapshotRow.age_271_365_qty), 0).label(
                "age_271_365_qty"
            ),
            func.coalesce(func.sum(InventorySnapshotRow.age_365_plus_qty), 0).label(
                "age_365_plus_qty"
            ),
            func.max(InventorySnapshotRow.recommended_action).label(
                "recommended_action"
            ),
        )
        .where(InventorySnapshotRow.source_file_id == source.id)
        .group_by(InventorySnapshotRow.sku)
    ).all()
    return {
        (_normalize_text(sku, max_length=128) or ""): _InventorySnapshot(
            available_qty=int(available_qty or 0),
            age_0_90_qty=int(age_0_90_qty or 0),
            age_91_180_qty=int(age_91_180_qty or 0),
            age_181_270_qty=int(age_181_270_qty or 0),
            age_271_365_qty=int(age_271_365_qty or 0),
            age_365_plus_qty=int(age_365_plus_qty or 0),
            recommended_action=str(recommended_action) if recommended_action else None,
        )
        for sku, available_qty, age_0_90_qty, age_91_180_qty, age_181_270_qty, age_271_365_qty, age_365_plus_qty, recommended_action in rows
        if _normalize_text(sku, max_length=128)
    }


def _load_in_transit_map(
    db: Session, project_id: int, country: str, report_date: date | None = None
) -> dict[str, int]:
    stmt = (
        select(
            ShipmentScheduleItem.sku,
            func.coalesce(func.sum(ShipmentScheduleItem.quantity), 0),
        )
        .join(
            ShipmentSchedule,
            ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
        )
        .where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == country,
        )
    )
    if report_date is not None:
        # Historical: reconstruct "was in transit as of report_date".
        # A shipment counts as in-transit if it existed before report_date
        # AND had not been received yet:
        #   - status != 'completed' (still in_transit / draft), OR
        #   - actual_inbound_date > report_date (completed, but after the query date)
        # Note: completed + actual_inbound_date=NULL is correctly excluded
        # (both OR branches evaluate to false/NULL).
        stmt = stmt.where(
            func.date(ShipmentSchedule.created_at) <= report_date,
            or_(
                ShipmentSchedule.shipment_status != "completed",
                ShipmentSchedule.actual_inbound_date > report_date,
            ),
        )
    else:
        # Current: use live status filter.
        stmt = stmt.where(
            ShipmentSchedule.shipment_status.in_(IN_TRANSIT_STATUSES),
        )
    rows = db.execute(stmt.group_by(ShipmentScheduleItem.sku)).all()
    return {
        _normalize_text(sku, max_length=128) or "": int(quantity or 0)
        for sku, quantity in rows
        if _normalize_text(sku, max_length=128)
    }


def _load_in_transit_batches(
    db: Session, project_id: int, country: str
) -> dict[str, list[_TransitBatch]]:
    """当前在途批次明细（按 SKU 分组，BLF-630）。

    与 ``_load_in_transit_map``（数量汇总）并存：时间线仅在实时路径使用；
    ``report_date`` 历史重建路径仍用汇总口径（无 eta 时间线可重建）。
    """
    stmt = (
        select(
            ShipmentScheduleItem.sku,
            ShipmentScheduleItem.quantity,
            ShipmentSchedule.eta_date,
            ShipmentSchedule.etd_date,
            ShipmentSchedule.created_date,
        )
        .join(
            ShipmentSchedule,
            ShipmentSchedule.id == ShipmentScheduleItem.shipment_schedule_id,
        )
        .where(
            ShipmentSchedule.project_id == project_id,
            ShipmentSchedule.country == country,
            ShipmentSchedule.shipment_status.in_(IN_TRANSIT_STATUSES),
        )
    )
    rows = db.execute(stmt).all()
    result: dict[str, list[_TransitBatch]] = {}
    for sku, quantity, eta_date, etd_date, created_date in rows:
        normalized_sku = _normalize_text(sku, max_length=128)
        if not normalized_sku:
            continue
        result.setdefault(normalized_sku, []).append(
            _TransitBatch(
                quantity=int(quantity or 0),
                eta_date=eta_date,
                etd_date=etd_date,
                created_date=created_date,
            )
        )
    return result


def _compute_coverage_timeline(
    today: date,
    available_inventory: int,
    weighted_dms: Decimal | None,
    transit_batches: list[_TransitBatch],
    shipping_days: int,
) -> tuple[date | None, date | None, int, date | None]:
    """连续覆盖时间线（BLF-630 spec §4.2-4.4）。

    返回 ``(continuous_end, gap_start, gap_days, next_transit_eta)``：

    - ``continuous_end``：**连续覆盖截止日**——按可售 + 各在途批次（按 ETA 排序）
      逐个并入，断档即截止；无断档时 = 全部并入后的总覆盖截止。
      它是 risk_status / 补货指令日期的锚点（spec §4.5/§4.7）。
    - ``gap_start``：首个断档开始日（无断档为 None）。
    - ``gap_days``：首段断档天数（0 = 无断档）。
    - ``next_transit_eta``：下一批在途预计到港日（eta 兜底链解析后最早）。

    eta 兜底链（spec §4.8）：eta_date → etd_date + shipping_days
    → created_date + shipping_days；无任何日期信息的批次不参与时间线。
    """
    if weighted_dms is None or weighted_dms <= 0:
        return None, None, 0, None
    coverage_days = Decimal(available_inventory) / weighted_dms
    continuous_end = today + timedelta(days=float(coverage_days))
    extended_end = continuous_end
    gap_start: date | None = None
    gap_days = 0

    batches: list[tuple[int, date]] = []
    for batch in transit_batches:
        eta = batch.eta_date
        if eta is None and batch.etd_date is not None:
            eta = batch.etd_date + timedelta(days=shipping_days)
        if eta is None and batch.created_date is not None:
            eta = batch.created_date + timedelta(days=shipping_days)
        if eta is None:
            continue  # 无任何日期信息：保守不参与时间线
        batches.append((batch.quantity, eta))
    if not batches:
        return continuous_end, None, 0, None

    batches.sort(key=lambda item: item[1])
    next_transit_eta = batches[0][1]
    for quantity, eta in batches:
        if eta <= extended_end:
            # 无断档续接
            extended_end += timedelta(days=float(Decimal(quantity) / weighted_dms))
        else:
            # 断档：连续覆盖截止于此（之后到 eta 无货）
            if gap_start is None:
                gap_start = extended_end
                gap_days = (eta - extended_end).days
            # 跨断档覆盖（补货建议用）：到货后重新起算
            extended_end = eta + timedelta(days=float(Decimal(quantity) / weighted_dms))
    if gap_start is not None:
        continuous_end = gap_start
    else:
        # 无断档：连续覆盖 = 全部批次并入后的总覆盖
        continuous_end = extended_end
    return continuous_end, gap_start, gap_days, next_transit_eta


def _load_product_name_map(
    db: Session, project_id: int, skus: list[str]
) -> dict[str, str]:
    """从 SkuRecord 预加载 SKU -> 产品名称,首条 active + 非空品名胜出。"""
    if not skus:
        return {}
    rows = db.execute(
        select(SkuRecord.sku, SkuRecord.product_name)
        .where(
            SkuRecord.project_id == project_id,
            SkuRecord.sku.in_(skus),
            SkuRecord.is_active.is_(True),
        )
        .order_by(SkuRecord.sku, SkuRecord.id.desc())
    ).all()
    result: dict[str, str] = {}
    for sku, product_name in rows:
        if sku not in result and product_name:
            result[sku] = product_name
    return result


def _load_asin_to_skus_map(base_rows: list[_BaseSkuRow]) -> dict[str, set[str]]:
    mapping: dict[str, set[str]] = {}
    for row in base_rows:
        normalized_asin = normalize_asin(row.asin)
        if not normalized_asin:
            continue
        mapping.setdefault(normalized_asin, set()).add(row.sku)
    return mapping


def _load_business_dms_map(
    db: Session,
    project_id: int,
    country: str,
    target_days: int,
    today: date,
    asin_to_skus: dict[str, set[str]],
) -> dict[str, Decimal]:
    source = _pick_business_source(db, project_id, country, target_days, today)
    if source is None:
        return {}
    rows = db.execute(
        select(
            AnalysisBusinessRow.asin,
            func.coalesce(func.sum(AnalysisBusinessRow.units_ordered), 0),
        )
        .where(AnalysisBusinessRow.source_file_id == source.id)
        .group_by(AnalysisBusinessRow.asin)
    ).all()

    result: dict[str, Decimal] = {}
    for asin, units_ordered in rows:
        normalized_asin = normalize_asin(asin)
        if not normalized_asin:
            continue
        skus = asin_to_skus.get(normalized_asin, set())
        if not skus:
            continue
        dms = Decimal(int(units_ordered or 0)) / Decimal(target_days)
        for sku in skus:
            result[sku] = result.get(sku, Decimal("0")) + dms
    return result


def _load_sales_dms_map(
    db: Session,
    project_id: int,
    country: str,
    today: date,
    window_days: int,
    lag_days: int = 0,
) -> dict[str, Decimal]:
    window_end = today - timedelta(days=lag_days)
    since = window_end - timedelta(days=window_days - 1)
    # BEL-348: 直接按行过滤（不再 JOIN source_file + is_current）。
    rows = db.execute(
        select(
            AnalysisSalesOrderRow.sku,
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0),
        )
        .where(
            *counted_sales_where(
                project_id=project_id,
                country=country,
                date_from=since,
                date_to=window_end,
            )
        )
        .group_by(AnalysisSalesOrderRow.sku)
    ).all()

    result: dict[str, Decimal] = {}
    for sku, quantity in rows:
        normalized_sku = _normalize_text(sku, max_length=128)
        if normalized_sku is None:
            continue
        result[normalized_sku] = Decimal(int(quantity or 0)) / Decimal(window_days)
    return result


def _load_recent_sales_dms_map(
    db: Session, project_id: int, country: str, today: date
) -> dict[str, Decimal]:
    return _load_sales_dms_map(
        db,
        project_id,
        country,
        today,
        RECENT_SALES_WINDOW_DAYS,
        lag_days=RECENT_SALES_LAG_DAYS,
    )


def _normalize_weighted_dms(
    dms_30: Decimal | None,
    dms_14: Decimal | None,
    dms_7: Decimal | None,
    dms_3: Decimal | None,
) -> Decimal | None:
    weighted_windows = [
        (dms_30, Decimal("0.10")),
        (dms_14, Decimal("0.30")),
        (dms_7, Decimal("0.60") if dms_3 is None else Decimal("0.30")),
        (dms_3, Decimal("0.30")),
    ]
    available = [
        (value, weight) for value, weight in weighted_windows if value is not None
    ]
    if not available:
        return None
    total_weight = sum((weight for _, weight in available), Decimal("0"))
    if total_weight <= 0:
        return None
    weighted_sum = sum((value * weight for value, weight in available), Decimal("0"))
    return weighted_sum / total_weight


def _add_days(base_date: date, days_value: Decimal | None) -> str | None:
    if days_value is None:
        return None
    dt = datetime.combine(base_date, time.min) + timedelta(days=float(days_value))
    return dt.date().isoformat()


def _estimate_replenishment_quantity(
    target_days: int,
    coverage_days_total: int | None,
    production_plus_shipping_days: int,
    weighted_dms: Decimal | None,
) -> int | None:
    """BLF-630 二轮：补货量动态化（目标覆盖模型）。

    补到"目标覆盖水位"：

        到货时剩余天数 = 连续覆盖天数 − 补货周期 L
        补货量 = max(0, (target_days − 到货时剩余) × DMS)

    - 断档自动多补（缺口计入，到货后直接拉回 target 水位）
    - 在途通过连续覆盖天数天然抵扣
    - 到货时剩余 ≥ target（est_days ≤ 0）→ 无需补货，返回 None
    """
    if weighted_dms is None or weighted_dms <= 0 or coverage_days_total is None:
        return None
    remaining_at_arrival = coverage_days_total - production_plus_shipping_days
    est_days = target_days - remaining_at_arrival
    if est_days <= 0:
        return None
    return _round_decimal_to_int(Decimal(est_days) * weighted_dms)


def _classify_risk(
    today: date,
    coverage_end_date_text: str | None,
    order_buffer_days: int | None,
    weighted_dms: Decimal | None,
) -> str:
    """风险状态判定（BLF-630 spec §4.5，锚点改为下单缓冲）。

    ``coverage_end_date`` 为连续覆盖截止日（首个断货点）；
    ``order_buffer_days = coverage_end − 补货周期 − today``。

    判定表（顺序短路）：
    1. DMS 缺失/≤0 或覆盖缺失 → 待补数据
    2. 已在断档中（覆盖截止 < today）→ 长期断货
    3. 已过最晚下单日（order_buffer < 0）→ 短期断货
    4. 0 ≤ order_buffer ≤ EMERGENCY_ORDER_BUFFER_DAYS → 断货风险
    5. 覆盖 ≤ 90 天 → 健康库存
    6. 覆盖 90-120 天 → 滞销
    7. 覆盖 > 120 天 → 严重滞销
    """
    if weighted_dms is None or weighted_dms <= 0 or coverage_end_date_text is None:
        return RISK_PENDING
    if order_buffer_days is None:
        return RISK_PENDING
    coverage_end_date = date.fromisoformat(coverage_end_date_text)
    days_diff = (coverage_end_date - today).days
    if days_diff < 0:
        return RISK_LONG_TERM_OUT_OF_STOCK
    if order_buffer_days < 0:
        return RISK_SHORT_TERM_OUT_OF_STOCK
    if order_buffer_days <= EMERGENCY_ORDER_BUFFER_DAYS:
        return RISK_OUT_OF_STOCK
    if days_diff <= 90:
        return RISK_HEALTHY
    if days_diff <= 120:
        return RISK_SLOW_MOVING
    return RISK_SEVERE_SLOW_MOVING


# ---------------------------------------------------------------------------
# 季节性补货分析 (Seasonal Replenishment)
# ---------------------------------------------------------------------------
# 与现有 list_inventory_replenishment_analysis 的区别：
# - 销量窗口由调用方传入 ``to_date``，向前回溯 90/30/14/7 天
# - 加权权重改为 90D×40% + 30D×30% + 14D×20% + 7D×10%（长周期权重更高）
# - 风险状态**不判定**（A4 决定），仅提供 sellable_days / sellout_date 供决策参考
# - 可选去年同期对比（YoY）：compare_year_offset=1 表示 [to-365-89, to-365]
# ---------------------------------------------------------------------------


@dataclass
class _SeasonalDmsRow:
    """单 SKU 的季节性 DMS 聚合结果。

    每个字段都是 ``units_ordered / window_days`` 的 Decimal。
    ``None`` 表示该窗口内没有任何销量记录（与现有 _load_sales_dms_map 行为一致）。
    """

    sku: str
    dms_90: Decimal | None
    dms_30: Decimal | None
    dms_14: Decimal | None
    dms_7: Decimal | None
    dms_90_yoy: Decimal | None
    dms_30_yoy: Decimal | None
    dms_14_yoy: Decimal | None
    dms_7_yoy: Decimal | None


# 季节性补货加权规则（与现有 _normalize_weighted_dms 不同）。
# 长周期权重高是因为季节性商品需要看 90D 趋势而非近期噪音。
SEASONAL_WEIGHT_90 = Decimal("0.40")
SEASONAL_WEIGHT_30 = Decimal("0.30")
SEASONAL_WEIGHT_14 = Decimal("0.20")
SEASONAL_WEIGHT_7 = Decimal("0.10")


def _normalize_seasonal_weighted_dms(
    dms_90: Decimal | None,
    dms_30: Decimal | None,
    dms_14: Decimal | None,
    dms_7: Decimal | None,
) -> Decimal | None:
    """季节性加权 DMS：90D×40% + 30D×30% + 14D×20% + 7D×10%。

    仅在所有窗口都缺失时返回 None；否则按"可用窗口"重新归一化权重，
    这样部分窗口缺失不会让结果偏低。
    """
    weighted_windows = [
        (dms_90, SEASONAL_WEIGHT_90),
        (dms_30, SEASONAL_WEIGHT_30),
        (dms_14, SEASONAL_WEIGHT_14),
        (dms_7, SEASONAL_WEIGHT_7),
    ]
    available = [
        (value, weight) for value, weight in weighted_windows if value is not None
    ]
    if not available:
        return None
    total_weight = sum((weight for _, weight in available), Decimal("0"))
    if total_weight <= 0:
        return None
    weighted_sum = sum((value * weight for value, weight in available), Decimal("0"))
    return weighted_sum / total_weight


def _build_seasonal_window_cases(
    today: date,
    compare_year_offset: int,
) -> tuple[
    list[tuple[int, date, date]],
    list[tuple[int, date, date]],
    date,
    date,
]:
    """构造季节性窗口元数据。

    Returns:
        main_cases: [(window_days, since, until), ...] 主窗口 4 个
        yoy_cases: [(window_days, since, until), ...] 去年同期 0/4 个
        outer_since: 外层 WHERE 用的最早日期下界
        outer_until: 外层 WHERE 用的最晚日期上界（= today）
    """
    windows = (90, 30, 14, 7)
    main_cases: list[tuple[int, date, date]] = []
    for n in windows:
        since = today - timedelta(days=n - 1)
        main_cases.append((n, since, today))

    yoy_cases: list[tuple[int, date, date]] = []
    if compare_year_offset > 0:
        yoy_until = today - timedelta(days=365 * compare_year_offset)
        for n in windows:
            since = yoy_until - timedelta(days=n - 1)
            yoy_cases.append((n, since, yoy_until))

    # outer_since = 去年最早窗口的左端（最小 since）
    # outer_until = today（主窗口都包含今天）
    outer_since = today
    for _, since, until in [*main_cases, *yoy_cases]:
        if since < outer_since:
            outer_since = since
    outer_until = today
    return main_cases, yoy_cases, outer_since, outer_until


def _load_seasonal_dms_map(
    db: Session,
    project_id: int,
    country: str,
    to_date: date,
    compare_year_offset: int = 1,
) -> dict[str, _SeasonalDmsRow]:
    """一次 SQL 算 4 主窗口 (+可选 4 去年同期窗口) 的 DMS。

    窗口定义（与 ``_load_sales_dms_map`` 一致，[since, until] 双闭区间）：
      - 主窗口：右端 = ``to_date``，长度 = 90/30/14/7 天
      - 去年同期：右端 = ``to_date - 365 * offset``，长度同上

    SQL 优化：
      - 外层 WHERE 把 ``purchase_date_pt`` 圈在所有窗口并集区间内
        （约 ``to_date - 365 - 89`` 到 ``to_date``），命中复合索引
        ``idx_analysis_sales_order_source_purchase_date (source_file_id, purchase_date_pt)``
      - 4~8 个 ``func.sum(case((date >= since, quantity), else_=0))`` 一次 group_by(sku)
      - 过滤条件复用 ``_load_sales_dms_map``：``is_current=True`` + ``is_counted_sales=True``
    """
    if compare_year_offset < 0:
        compare_year_offset = 0

    main_cases, yoy_cases, outer_since, outer_until = _build_seasonal_window_cases(
        to_date, compare_year_offset
    )

    # 构造聚合表达式：每个窗口一个 SUM(CASE WHEN date >= since THEN quantity ELSE 0 END)
    # 外层 WHERE 已经把上界限定为 outer_until，所以这里只判断下界
    aggregates: dict[str, Any] = {"sku": AnalysisSalesOrderRow.sku.label("sku")}
    for window_days, since, _until in main_cases:
        aggregates[f"sum_{window_days}"] = func.sum(
            case(
                (
                    AnalysisSalesOrderRow.purchase_date_pt >= since,
                    AnalysisSalesOrderRow.quantity,
                ),
                else_=0,
            )
        ).label(f"sum_{window_days}")
    for window_days, since, until in yoy_cases:
        aggregates[f"sum_{window_days}_yoy"] = func.sum(
            case(
                (
                    and_(
                        AnalysisSalesOrderRow.purchase_date_pt >= since,
                        AnalysisSalesOrderRow.purchase_date_pt <= until,
                    ),
                    AnalysisSalesOrderRow.quantity,
                ),
                else_=0,
            )
        ).label(f"sum_{window_days}_yoy")

    stmt = (
        select(*aggregates.values())
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSalesOrderRow.is_counted_sales.is_(True),
            AnalysisSalesOrderRow.purchase_date_pt >= outer_since,
            AnalysisSalesOrderRow.purchase_date_pt <= outer_until,
        )
        .group_by(AnalysisSalesOrderRow.sku)
    )

    rows = db.execute(stmt).all()

    def _dms(window_days: int, qty: int | None) -> Decimal | None:
        if qty is None or qty == 0:
            return None
        return Decimal(int(qty)) / Decimal(window_days)

    result: dict[str, _SeasonalDmsRow] = {}
    for row in rows:
        normalized = _normalize_text(row.sku, max_length=128)
        if normalized is None:
            continue
        result[normalized] = _SeasonalDmsRow(
            sku=normalized,
            dms_90=_dms(90, getattr(row, "sum_90", None)),
            dms_30=_dms(30, getattr(row, "sum_30", None)),
            dms_14=_dms(14, getattr(row, "sum_14", None)),
            dms_7=_dms(7, getattr(row, "sum_7", None)),
            dms_90_yoy=_dms(90, getattr(row, "sum_90_yoy", None)),
            dms_30_yoy=_dms(30, getattr(row, "sum_30_yoy", None)),
            dms_14_yoy=_dms(14, getattr(row, "sum_14_yoy", None)),
            dms_7_yoy=_dms(7, getattr(row, "sum_7_yoy", None)),
        )
    return result


def list_seasonal_replenishment_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    from_date: date,
    to_date: date,
    compare_year_offset: int,
    keyword: str | None,
    page: int,
    page_size: int,
) -> tuple[list[dict[str, object]], dict[str, int], int, bool]:
    """季节性补货分析主流程。

    与 ``list_inventory_replenishment_analysis`` 的区别：
      - 销量窗口由 ``to_date`` 决定（不是 date.today()）
      - 加权权重是 SEASONAL_WEIGHT_*（长周期高权重）
      - **不判定** risk_status（A4 决定）
      - sellout_date 锚点 = ``to_date`` + sellable_days（不是 today + sellable_days）
      - 复用 InventoryReplenishmentSummary，但风险计数字段固定为 0
    """
    project = _get_project_or_404(db, project_id)
    normalized_country = normalize_country(country)

    # 复用现有 5 个 loader
    base_rows = _load_base_skus(db, project, normalized_country)
    settings_map = _load_settings_map(db, project.id, normalized_country)
    inventory_map = _load_inventory_map(db, project.id, normalized_country)
    in_transit_map = _load_in_transit_map(db, project.id, normalized_country)
    product_name_map = _load_product_name_map(
        db, project.id, [row.sku for row in base_rows]
    )

    # 一次性拿到 4~8 个窗口的 DMS
    dms_map = _load_seasonal_dms_map(
        db,
        project.id,
        normalized_country,
        to_date=to_date,
        compare_year_offset=compare_year_offset,
    )

    keyword_text = (keyword or "").strip().lower()
    rows: list[dict[str, object]] = []

    for base_row in base_rows:
        setting = settings_map.get((base_row.sku, base_row.country))
        asin = _normalize_text(
            setting.asin if setting and setting.asin else base_row.asin,
            max_length=64,
        )
        snap = inventory_map.get(base_row.sku)
        available_inventory = snap.available_qty if snap else 0
        in_transit_quantity = int(in_transit_map.get(base_row.sku, 0))
        dms_row = dms_map.get(base_row.sku)

        dms_90 = dms_row.dms_90 if dms_row else None
        dms_30 = dms_row.dms_30 if dms_row else None
        dms_14 = dms_row.dms_14 if dms_row else None
        dms_7 = dms_row.dms_7 if dms_row else None
        dms_90_yoy = dms_row.dms_90_yoy if dms_row else None
        dms_30_yoy = dms_row.dms_30_yoy if dms_row else None
        dms_14_yoy = dms_row.dms_14_yoy if dms_row else None
        dms_7_yoy = dms_row.dms_7_yoy if dms_row else None

        base_dms = _normalize_seasonal_weighted_dms(dms_90, dms_30, dms_14, dms_7)
        safety_factor = (
            setting.safety_factor if setting is not None else DEFAULT_SAFETY_FACTOR
        )
        weighted_dms = (
            None if base_dms is None else base_dms * (Decimal("1") + safety_factor)
        )
        if weighted_dms is not None and weighted_dms <= 0:
            weighted_dms = None
        sellable_days = (
            None
            if weighted_dms is None
            else Decimal(available_inventory) / weighted_dms
        )
        # 关键区别：锚点 = to_date（不是 today）
        sellout_date = _add_days(to_date, sellable_days)
        sellable_days_with_transit = (
            None
            if weighted_dms is None
            else Decimal(available_inventory + in_transit_quantity) / weighted_dms
        )
        sellout_date_with_transit = _add_days(to_date, sellable_days_with_transit)

        production_lead_days = (
            setting.production_lead_days
            if setting is not None
            else DEFAULT_PRODUCTION_LEAD_DAYS
        )
        shipping_days = (
            setting.shipping_days if setting is not None else DEFAULT_SHIPPING_DAYS
        )
        estimated_replenishment_quantity = (
            _round_decimal_to_int(
                Decimal(production_lead_days + shipping_days) * weighted_dms
            )
            if weighted_dms is not None
            else None
        )

        if (
            keyword_text
            and keyword_text not in base_row.sku.lower()
            and keyword_text not in (asin or "").lower()
        ):
            continue

        rows.append(
            {
                "project_id": project.id,
                "project_name": project.project_name,
                "sku": base_row.sku,
                "country": base_row.country,
                "asin": asin,
                "product_name": product_name_map.get(base_row.sku),
                "available_inventory": available_inventory,
                "in_transit_quantity": in_transit_quantity,
                "dms_90": _decimal_to_float(dms_90),
                "dms_30": _decimal_to_float(dms_30),
                "dms_14": _decimal_to_float(dms_14),
                "dms_7": _decimal_to_float(dms_7),
                "dms_90_yoy": _decimal_to_float(dms_90_yoy),
                "dms_30_yoy": _decimal_to_float(dms_30_yoy),
                "dms_14_yoy": _decimal_to_float(dms_14_yoy),
                "dms_7_yoy": _decimal_to_float(dms_7_yoy),
                "base_dms": _decimal_to_float(base_dms),
                "weighted_dms": _decimal_to_float(weighted_dms),
                "sellable_days": _decimal_to_float(
                    _round_decimal(sellable_days, digits=2), digits=2
                )
                if sellable_days is not None
                else None,
                "sellout_date": sellout_date,
                "sellout_date_with_transit": sellout_date_with_transit,
                "production_lead_days": production_lead_days,
                "shipping_days": shipping_days,
                "estimated_replenishment_quantity": estimated_replenishment_quantity,
            }
        )

    summary = {
        # 季节性页面不判定风险，所以这三个字段固定 0
        # 前端不会展示对应的统计卡，避免误导
        "sku_count": len(rows),
        "out_of_stock_risk_count": 0,
        "healthy_count": sum(1 for item in rows if item["weighted_dms"] is not None),
        "slow_moving_count": 0,
        "pending_data_count": sum(1 for item in rows if item["weighted_dms"] is None),
        "total_available_inventory": sum(
            int(item["available_inventory"]) for item in rows
        ),
        "total_in_transit_quantity": sum(
            int(item["in_transit_quantity"]) for item in rows
        ),
    }
    total = len(rows)
    paged = rows[(page - 1) * page_size : (page - 1) * page_size + page_size + 1]
    has_next = len(paged) > page_size
    return paged[:page_size], summary, total, has_next


def list_snapshot_options(
    db: Session,
    project_id: int,
    country: str = "US",
) -> list[dict]:
    rows = db.execute(
        select(
            func.max(AnalysisSourceFile.id).label("max_id"),
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_date.isnot(None),
        )
        .group_by(
            AnalysisSourceFile.project_id,
            AnalysisSourceFile.country,
            AnalysisSourceFile.report_date,
        )
    ).all()

    current_ids: set[int] = set()
    if rows:
        current_rows = db.execute(
            select(AnalysisSourceFile.id).where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.report_date.isnot(None),
                AnalysisSourceFile.is_current.is_(True),
            )
        ).all()
        current_ids = {r.id for r in current_rows}

    option_rows = db.execute(
        select(
            AnalysisSourceFile.report_date.label("report_date"),
            func.max(AnalysisSourceFile.id).label("max_id"),
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_date.isnot(None),
        )
        .group_by(AnalysisSourceFile.report_date)
        .order_by(AnalysisSourceFile.report_date.desc())
    ).all()

    return [
        {"report_date": row.report_date, "is_current": row.max_id in current_ids}
        for row in option_rows
    ]


def list_inventory_replenishment_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    keyword: str | None,
    risk_status: str | None,
    in_transit_only: bool,
    page: int,
    page_size: int,
    report_date: date | None = None,
    inventory_state: str | None = None,
    replenishment_action: str | None = None,
    order_by: str | None = None,
    order_dir: str = "asc",
    today: date | None = None,
) -> tuple[list[dict[str, object]], dict[str, int], int, bool]:
    project = _get_project_or_404(db, project_id)
    normalized_country = normalize_country(country)
    # BLF-1016 复审[7]：实时路径（``report_date=None``）的「今天」由调用方
    # 注入，避免 service 自己再读一次挂钟——slot 声明的口径日、DMS 窗口、
    # 快照年龄都锚在**同一个**参照日上（跨午夜不再分裂）。
    today = report_date if report_date is not None else (today or date.today())
    # BLF-502 S4 / BLF-1016 复审[7]：快照年龄必须量自**数据加载器实际使用**
    # 的那份快照文件——历史路径 = ``<= report_date`` 最近一份，实时路径 =
    # 「最新一份」（无上界，与 ``_load_inventory_map`` 同一谓词），否则存在
    # 晚于参照日的快照文件时，signals 的新鲜度与 rows 的来源各说一套。
    if report_date is None:
        source_snapshot_date = current_inventory_snapshot_report_date(
            db, project.id, normalized_country
        )
    else:
        source_snapshot_date = latest_inventory_snapshot_date(
            db, project.id, normalized_country, today
        )
    snapshot_age_days = (
        0
        if source_snapshot_date is None
        else max(0, (today - source_snapshot_date).days)
    )
    base_rows = _load_base_skus(db, project, normalized_country)
    settings_map = _load_settings_map(db, project.id, normalized_country)
    inventory_map = _load_inventory_map(
        db, project.id, normalized_country, report_date=report_date
    )
    in_transit_map = _load_in_transit_map(
        db, project.id, normalized_country, report_date=report_date
    )
    # BLF-630: 实时路径加载在途批次时间线（历史快照路径无 eta 可重建，保持汇总口径）
    transit_batches_map = (
        _load_in_transit_batches(db, project.id, normalized_country)
        if report_date is None
        else {}
    )
    product_name_map = _load_product_name_map(
        db, project.id, [row.sku for row in base_rows]
    )
    dms_30_map = _load_sales_dms_map(db, project.id, normalized_country, today, 30)
    dms_14_map = _load_sales_dms_map(db, project.id, normalized_country, today, 14)
    dms_7_map = _load_sales_dms_map(db, project.id, normalized_country, today, 7)
    dms_3_map = _load_sales_dms_map(
        db,
        project.id,
        normalized_country,
        today,
        RECENT_SALES_WINDOW_DAYS,
        lag_days=RECENT_SALES_LAG_DAYS,
    )
    # v1.2 三段式/季节性：一次性取 4 主窗口 + 去年同期窗口的 DMS，供
    # compute_seasonal_factor 使用（修复 NameError: seasonal_dms_map 未定义）。
    seasonal_dms_map = _load_seasonal_dms_map(
        db,
        project.id,
        normalized_country,
        to_date=today,
        compare_year_offset=1,
    )

    keyword_text = (keyword or "").strip().lower()
    normalized_risk = (risk_status or "").strip()
    state_filter = {s.strip() for s in (inventory_state or "").split(",") if s.strip()}
    action_filter = {
        a.strip() for a in (replenishment_action or "").split(",") if a.strip()
    }
    rows: list[dict[str, object]] = []

    for base_row in base_rows:
        setting = settings_map.get((base_row.sku, base_row.country))
        asin = _normalize_text(
            setting.asin if setting and setting.asin else base_row.asin, max_length=64
        )
        snap = inventory_map.get(base_row.sku)
        available_inventory = snap.available_qty if snap else 0
        in_transit_quantity = int(in_transit_map.get(base_row.sku, 0))
        dms_30 = dms_30_map.get(base_row.sku)
        dms_14 = dms_14_map.get(base_row.sku)
        dms_7 = dms_7_map.get(base_row.sku)
        dms_3 = dms_3_map.get(base_row.sku)
        base_dms = _normalize_weighted_dms(dms_30, dms_14, dms_7, dms_3)
        safety_factor = (
            setting.safety_factor if setting is not None else DEFAULT_SAFETY_FACTOR
        )
        weighted_dms = (
            None if base_dms is None else base_dms * (Decimal("1") + safety_factor)
        )
        if weighted_dms is not None and weighted_dms <= 0:
            weighted_dms = None
        sellable_days = (
            None
            if weighted_dms is None
            else Decimal(available_inventory) / weighted_dms
        )
        sellout_date = _add_days(today, sellable_days)
        sellable_days_with_transit = (
            None
            if weighted_dms is None
            else Decimal(available_inventory + in_transit_quantity) / weighted_dms
        )
        sellout_date_with_transit = _add_days(today, sellable_days_with_transit)
        production_lead_days = (
            setting.production_lead_days
            if setting is not None
            else DEFAULT_PRODUCTION_LEAD_DAYS
        )
        shipping_days = (
            setting.shipping_days if setting is not None else DEFAULT_SHIPPING_DAYS
        )
        replenishment_order_date = None
        warehouse_entry_date = None
        shipment_order_date = None
        risk_anchor_date = None
        latest_order_date = None
        order_buffer_days = None
        coverage_end_date = None
        gap_start_date = None
        gap_days = 0
        next_transit_eta = None
        production_plus_shipping_days = production_lead_days + shipping_days
        if weighted_dms is not None and weighted_dms > 0:
            if report_date is None:
                continuous_end, gap_start, gap_days_calc, next_eta = (
                    _compute_coverage_timeline(
                        today,
                        available_inventory,
                        weighted_dms,
                        transit_batches_map.get(base_row.sku, []),
                        shipping_days,
                    )
                )
            else:
                # 历史快照路径：无在途时间线，连续覆盖 = 含在途总覆盖（汇总口径）
                coverage_days = Decimal(available_inventory + in_transit_quantity) / (
                    weighted_dms
                )
                continuous_end = today + timedelta(days=float(coverage_days))
                gap_start, gap_days_calc, next_eta = None, 0, None
            if continuous_end is not None:
                coverage_end_date = continuous_end.isoformat()
                gap_start_date = (
                    gap_start.isoformat() if gap_start is not None else None
                )
                gap_days = gap_days_calc
                next_transit_eta = (
                    next_eta.isoformat() if next_eta is not None else None
                )
                latest_order_date = (
                    continuous_end - timedelta(days=production_plus_shipping_days)
                ).isoformat()
                order_buffer_days = (
                    continuous_end
                    - timedelta(days=production_plus_shipping_days)
                    - today
                ).days
                replenishment_order_date = latest_order_date
                warehouse_entry_date = (
                    date.fromisoformat(latest_order_date) + timedelta(days=7)
                ).isoformat()
                shipment_order_date = (
                    date.fromisoformat(latest_order_date)
                    + timedelta(days=production_lead_days)
                ).isoformat()
                risk_anchor_date = coverage_end_date
        risk = _classify_risk(today, coverage_end_date, order_buffer_days, weighted_dms)
        # BLF-630 二轮: 目标覆盖天数（可配置，缺省 90）
        target_days = (
            setting.target_days if setting is not None else DEFAULT_TARGET_DAYS
        )
        # BLF-630 二轮: 补货量动态化——补到"目标覆盖水位"（见 _estimate_replenishment_quantity）
        estimated_replenishment_quantity = None
        if risk not in {RISK_SLOW_MOVING, RISK_SEVERE_SLOW_MOVING}:
            coverage_days_total = (
                (date.fromisoformat(coverage_end_date) - today).days
                if coverage_end_date is not None
                else None
            )
            estimated_replenishment_quantity = _estimate_replenishment_quantity(
                target_days,
                coverage_days_total,
                production_plus_shipping_days,
                weighted_dms,
            )

        # v1.2 三段式判定（spec §2.1-2.4）
        seasonal_dms = seasonal_dms_map.get(base_row.sku)
        dms_30_yoy = (
            _decimal_to_float(seasonal_dms.dms_30_yoy) if seasonal_dms else None
        )
        dms_7_yoy = _decimal_to_float(seasonal_dms.dms_7_yoy) if seasonal_dms else None

        seasonal_factor, seasonal_phase, seasonal_source = compute_seasonal_factor(
            dms_30=_decimal_to_float(dms_30),
            dms_7=_decimal_to_float(dms_7),
            dms_30_yoy=dms_30_yoy,
            dms_7_yoy=dms_7_yoy,
        )

        sellable_days_float = (
            _decimal_to_float(_round_decimal(sellable_days, digits=2), digits=2)
            if sellable_days is not None
            else None
        )
        adjusted_sellable_days = compute_seasonal_adjusted_sellable_days(
            sellable_days=sellable_days_float,
            seasonal_factor=seasonal_factor,
        )

        trend_label = compute_trend_label(
            _decimal_to_float(dms_7), _decimal_to_float(dms_30)
        )
        trend_momentum = compute_trend_momentum(
            _decimal_to_float(dms_7),
            _decimal_to_float(dms_14),
            _decimal_to_float(dms_30),
        )

        item_input = ItemInput(
            available_qty=available_inventory,
            sellable_days=sellable_days_float,
            dms_30=_decimal_to_float(dms_30),
            dms_14=_decimal_to_float(dms_14),
            dms_7=_decimal_to_float(dms_7),
            dms_3=_decimal_to_float(dms_3),
            age_0_90_qty=snap.age_0_90_qty if snap else 0,
            age_91_180_qty=snap.age_91_180_qty if snap else 0,
            age_181_270_qty=snap.age_181_270_qty if snap else 0,
            age_271_365_qty=snap.age_271_365_qty if snap else 0,
            age_365_plus_qty=snap.age_365_plus_qty if snap else 0,
            in_transit_qty=in_transit_quantity,
        )

        inventory_state, critical_subtype, state_rule = compute_inventory_state(
            item_input, trend_label, adjusted_sellable_days, order_buffer_days
        )

        transit_ratio_value = (
            in_transit_quantity / available_inventory
            if available_inventory > 0
            else 0.0
        )
        replenishment_action, action_rule, seasonal_override = (
            compute_replenishment_action(
                inventory_state,
                critical_subtype,
                trend_label,
                transit_ratio_value,
                seasonal_phase,
                adjusted_sellable_days=adjusted_sellable_days,
                order_buffer_days=order_buffer_days,
            )
        )

        signals_dict = compute_signals(
            item_input,
            trend_label,
            trend_momentum,
            snapshot_age_days,
            seasonal_factor,
            seasonal_phase,
            seasonal_source,
        )
        signals_obj = InventorySignals(**signals_dict)

        if (
            keyword_text
            and keyword_text not in base_row.sku.lower()
            and keyword_text not in (asin or "").lower()
        ):
            continue
        if normalized_risk and normalized_risk != "all" and risk != normalized_risk:
            continue
        if in_transit_only and in_transit_quantity <= 0:
            continue
        if state_filter and inventory_state not in state_filter:
            continue
        if action_filter and replenishment_action not in action_filter:
            continue

        rows.append(
            {
                "project_id": project.id,
                "project_name": project.project_name,
                "sku": base_row.sku,
                "country": base_row.country,
                "asin": asin,
                "product_name": product_name_map.get(base_row.sku),
                "available_inventory": available_inventory,
                "in_transit_quantity": in_transit_quantity,
                "dms_30": _decimal_to_float(dms_30),
                "dms_14": _decimal_to_float(dms_14),
                "dms_7": _decimal_to_float(dms_7),
                "dms_3": _decimal_to_float(dms_3),
                "base_dms": _decimal_to_float(base_dms),
                "safety_factor": _decimal_to_float(safety_factor) or 0.0,
                "weighted_dms": _decimal_to_float(weighted_dms),
                "sellable_days": _decimal_to_float(
                    _round_decimal(sellable_days, digits=2), digits=2
                )
                if sellable_days is not None
                else None,
                "sellout_date": sellout_date,
                "sellout_date_with_transit": sellout_date_with_transit,
                "production_lead_days": production_lead_days,
                "shipping_days": shipping_days,
                "replenishment_order_date": replenishment_order_date,
                "warehouse_entry_date": warehouse_entry_date,
                "shipment_order_date": shipment_order_date,
                "estimated_replenishment_quantity": estimated_replenishment_quantity,
                "risk_status": risk,
                "risk_anchor_date": risk_anchor_date,
                # ── BLF-630: 补货周期 / 覆盖时间线维度 ──
                "production_plus_shipping_days": production_plus_shipping_days,
                "latest_order_date": latest_order_date,
                "order_buffer_days": order_buffer_days,
                "coverage_end_date": coverage_end_date,
                "gap_days": gap_days,
                "gap_start_date": gap_start_date,
                "next_transit_eta": next_transit_eta,
                "target_days": target_days,
                # ── Age bucket (from FBA inventory snapshot) ──
                "age_0_90_qty": snap.age_0_90_qty if snap else 0,
                "age_91_180_qty": snap.age_91_180_qty if snap else 0,
                "age_181_270_qty": snap.age_181_270_qty if snap else 0,
                "age_271_365_qty": snap.age_271_365_qty if snap else 0,
                "age_365_plus_qty": snap.age_365_plus_qty if snap else 0,
                "recommended_action": snap.recommended_action if snap else None,
                # v1.2: 三段式（spec §3.2）
                "inventory_state": inventory_state,
                "replenishment_action": replenishment_action,
                # BLF-1016：行是数据载体，必须 JSON 原生——canonical slot 的
                # ``json_safe`` 遇非 JSON 类型即抛（宁可提交失败也不写坏行，
                # 这是它的既定契约）。前端/agent 两条消费路径都只读字段值。
                "signals": signals_obj.model_dump(mode="json"),
                # BLF-502 S3: 决策路径解释（G1）——rule 码供 Agent 解释"为什么这么判"
                "decision_path": {
                    "state_rule": state_rule,
                    "critical_subtype": critical_subtype,
                    "action_rule": action_rule,
                    "seasonal_override": seasonal_override,
                    "seasonal_phase_used": seasonal_phase,
                },
            }
        )

    summary = {
        "sku_count": len(rows),
        "out_of_stock_risk_count": sum(
            1
            for item in rows
            if item["risk_status"]
            in {
                RISK_OUT_OF_STOCK,
                RISK_SHORT_TERM_OUT_OF_STOCK,
                RISK_LONG_TERM_OUT_OF_STOCK,
            }
        ),
        "healthy_count": sum(1 for item in rows if item["risk_status"] == RISK_HEALTHY),
        "slow_moving_count": sum(
            1
            for item in rows
            if item["risk_status"] in {RISK_SLOW_MOVING, RISK_SEVERE_SLOW_MOVING}
        ),
        "pending_data_count": sum(
            1 for item in rows if item["risk_status"] == RISK_PENDING
        ),
        "total_available_inventory": sum(
            int(item["available_inventory"]) for item in rows
        ),
        "total_in_transit_quantity": sum(
            int(item["in_transit_quantity"]) for item in rows
        ),
        # v1.2: 三段式 state 计数（spec §3.2 summary 字段）
        "critical_count": sum(
            1 for item in rows if item.get("inventory_state") == "critical"
        ),
        "deteriorating_count": sum(
            1 for item in rows if item.get("inventory_state") == "deteriorating"
        ),
        "watch_count": sum(
            1 for item in rows if item.get("inventory_state") == "watch"
        ),
        "healthy_count_v2": sum(
            1 for item in rows if item.get("inventory_state") == "healthy"
        ),
        "unknown_count": sum(
            1 for item in rows if item.get("inventory_state") == "unknown"
        ),
    }
    # BLF-502 S6: 分布（G5）——state/action 单维 + state×action 交叉矩阵
    state_distribution = {s: 0 for s in STATE_VALUES}
    action_distribution = {a: 0 for a in ACTION_VALUES}
    state_action_matrix = {s: {a: 0 for a in ACTION_VALUES} for s in STATE_VALUES}
    for item in rows:
        st = item.get("inventory_state") or "unknown"
        act = item.get("replenishment_action") or "NO_ACTION"
        if st in state_distribution:
            state_distribution[st] += 1
        if act in action_distribution:
            action_distribution[act] += 1
        if st in state_action_matrix and act in state_action_matrix[st]:
            state_action_matrix[st][act] += 1
    summary.update(
        {
            "state_distribution": state_distribution,
            "action_distribution": action_distribution,
            "state_action_matrix": state_action_matrix,
        }
    )
    total = len(rows)
    if order_by and rows:
        _sort_rows(rows, order_by, order_dir)
    paged = rows[(page - 1) * page_size : (page - 1) * page_size + page_size + 1]
    has_next = len(paged) > page_size
    return paged[:page_size], summary, total, has_next


def latest_inventory_snapshot_date(
    db: Session, project_id: int, country: str, today: date
) -> date | None:
    """历史路径（指定 ``report_date``）下最近一份库存快照的 report_date。

    即 ``_get_inventory_source(report_date=<某日>)`` 会选中的那份文件的上界
    版本；无快照返回 None。「无快照」与「快照就是今天」都折成 0 天会让缺数
    看起来像新鲜，故把查询本身暴露成公开函数供 slot 与 signals 共用。
    """
    row = db.execute(
        select(func.max(AnalysisSourceFile.report_date)).where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.report_date.isnot(None),
            AnalysisSourceFile.report_date <= today,
        )
    ).first()
    return row[0] if row else None


def current_inventory_snapshot_report_date(
    db: Session, project_id: int, country: str
) -> date | None:
    """实时路径（``report_date=None``）**实际使用**的快照文件的 report_date。

    ``_load_inventory_map(report_date=None)`` 经 ``_get_inventory_source`` 的
    「最新一份」分支取数，该分支**没有** ``<= today`` 上界。若 slot 另起一条
    有上界的查询来声明数据口径日，二者在「存在晚于参照日的快照文件」时就会
    给出两个不同日期：audit slot 声称的数据口径与 rows 的真实来源漂移
    （BLF-1016 复审[7]）。这里直接复用数据加载器同一个函数，谓词不可能分叉。
    """
    from app.services.inventory_analysis_service import _get_inventory_source

    source = _get_inventory_source(
        db, project_id=project_id, country=country, report_date=None
    )
    return source.report_date if source is not None else None


def _sort_rows(rows: list[dict[str, object]], order_by: str, order_dir: str) -> None:
    """BLF-502 S5：R1 排序（Python 侧，None 恒排后）。

    白名单字段在 ``REPLENISHMENT_ORDER_BY_FIELDS``；不在白名单时保持原序。
    """
    if order_by not in REPLENISHMENT_ORDER_BY_FIELDS:
        return
    reverse = order_dir == "desc"

    def key_fn(row: dict[str, object]) -> tuple[int, object]:
        value = row.get(order_by)
        # 不能写成 ``value or ""``：数值 0 会退化成空串，与同列的非零数值
        # 比较直接 TypeError（sellable_days / available_inventory 为 0 是
        # 常态——零库存 SKU）。这里只把 None 折进「排后」组。
        return (1 if value is None else 0, value if value is not None else "")

    rows.sort(key=key_fn, reverse=reverse)


def list_inventory_replenishment_settings(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
    sku: str | None = None,
) -> list[dict[str, object]]:
    """BLF-502 S7/R5：补货设置列表（Agent 配置审计，G8）。"""
    stmt = (
        select(InventoryReplenishmentSetting)
        .where(
            InventoryReplenishmentSetting.project_id == project_id,
            InventoryReplenishmentSetting.country == normalize_country(country),
        )
        .order_by(InventoryReplenishmentSetting.sku.asc())
    )
    if sku:
        stmt = stmt.where(
            InventoryReplenishmentSetting.sku.like(
                f"%{_normalize_text(sku, max_length=128)}%"
            )
        )
    return [
        {
            "project_id": r.project_id,
            "project_name": r.project_name,
            "sku": r.sku,
            "country": r.country,
            "asin": r.asin,
            "production_lead_days": r.production_lead_days,
            "shipping_days": r.shipping_days,
            "safety_factor": float(r.safety_factor),
            "target_days": r.target_days,
        }
        for r in db.scalars(stmt).all()
    ]


def count_replenishment_base_skus(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
) -> int:
    """BLF-502 R4：基表 SKU 数（ProductCost 启用项 ∪ 补货设置，口径同 _load_base_skus）。"""
    project = _get_project_or_404(db, project_id)
    return len(_load_base_skus(db, project, normalize_country(country)))


def count_replenishment_configured_settings(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
) -> int:
    """BLF-502 R4：有自定义补货设置的 SKU 数。"""
    return int(
        db.execute(
            select(func.count())
            .select_from(InventoryReplenishmentSetting)
            .where(
                InventoryReplenishmentSetting.project_id == project_id,
                InventoryReplenishmentSetting.country == normalize_country(country),
            )
        ).scalar_one()
    )


def get_sales_data_span(
    db: Session,
    *,
    project_id: int,
    country: str = "US",
) -> dict[str, object]:
    """BLF-502 S8/R4：销售数据跨度（已计入订单行的最大购买日期）。"""
    row = db.execute(
        select(func.max(AnalysisSalesOrderRow.purchase_date_pt)).where(
            AnalysisSalesOrderRow.project_id == project_id,
            AnalysisSalesOrderRow.country == normalize_country(country),
            AnalysisSalesOrderRow.is_counted_sales.is_(True),
        )
    ).first()
    max_date = row[0] if row else None
    return {
        "max_sales_date": max_date.isoformat() if max_date else None,
        "window_days": RECENT_SALES_WINDOW_DAYS,
    }


def upsert_inventory_replenishment_setting(
    db: Session,
    *,
    project_id: int,
    sku: str,
    country: str,
    asin: str | None,
    production_lead_days: int,
    shipping_days: int,
    safety_factor: float,
    target_days: int | None = None,
    operator: str | None,
) -> InventoryReplenishmentSetting:
    project = _get_project_or_404(db, project_id)
    normalized_sku = _normalize_text(sku, max_length=128)
    normalized_country = normalize_country(country)
    if normalized_sku is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="sku 不能为空"
        )

    row = (
        db.execute(
            select(InventoryReplenishmentSetting).where(
                InventoryReplenishmentSetting.project_id == project.id,
                InventoryReplenishmentSetting.sku == normalized_sku,
                InventoryReplenishmentSetting.country == normalized_country,
            )
        )
        .scalars()
        .first()
    )
    if row is None:
        row = InventoryReplenishmentSetting(
            project_id=project.id,
            project_name=project.project_name,
            sku=normalized_sku,
            country=normalized_country,
            asin=_normalize_text(asin, max_length=64),
            production_lead_days=production_lead_days,
            shipping_days=shipping_days,
            safety_factor=Decimal(str(safety_factor)),
            target_days=(
                target_days if target_days is not None else DEFAULT_TARGET_DAYS
            ),
            created_by=_normalize_text(operator, max_length=255),
            updated_by=_normalize_text(operator, max_length=255),
        )
        db.add(row)
    else:
        row.project_name = project.project_name
        row.country = normalized_country
        row.asin = _normalize_text(asin, max_length=64)
        row.production_lead_days = production_lead_days
        row.shipping_days = shipping_days
        row.safety_factor = Decimal(str(safety_factor))
        if target_days is not None:
            row.target_days = target_days
        row.updated_by = _normalize_text(operator, max_length=255)

    db.flush()
    db.refresh(row)
    return row


def list_inventory_replenishment_shipments(
    db: Session,
    *,
    project_id: int,
    sku: str,
) -> list[dict[str, object]]:
    _get_project_or_404(db, project_id)
    normalized_sku = _normalize_text(sku, max_length=128)
    if normalized_sku is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="sku 不能为空"
        )

    rows = db.execute(
        select(ShipmentSchedule, ShipmentScheduleItem)
        .join(
            ShipmentScheduleItem,
            ShipmentScheduleItem.shipment_schedule_id == ShipmentSchedule.id,
        )
        .where(
            ShipmentSchedule.project_id == project_id,
            ShipmentScheduleItem.sku == normalized_sku,
        )
        .order_by(
            func.coalesce(
                ShipmentSchedule.created_date,
                ShipmentSchedule.etd_date,
            ).desc(),
            ShipmentSchedule.created_date.desc(),
            ShipmentSchedule.etd_date.desc(),
            ShipmentSchedule.id.desc(),
        )
    ).all()

    payload: list[dict[str, object]] = []
    for schedule, item in rows:
        payload.append(
            {
                "schedule_id": int(schedule.id),
                "shipment_no": str(schedule.shipment_no),
                "shipment_status": str(schedule.shipment_status),
                "shipping_method": str(schedule.shipping_method),
                "etd_date": schedule.etd_date.isoformat()
                if schedule.etd_date
                else None,
                "eta_date": schedule.eta_date.isoformat()
                if schedule.eta_date
                else None,
                "actual_inbound_date": schedule.actual_inbound_date.isoformat()
                if schedule.actual_inbound_date
                else None,
                "tracking_no": schedule.tracking_no,
                "quantity": int(item.quantity),
                "remark": item.remark or schedule.remark,
                "updated_at": schedule.updated_at.astimezone(UTC).isoformat()
                if schedule.updated_at.tzinfo
                else schedule.updated_at.isoformat(),
            }
        )
    return payload

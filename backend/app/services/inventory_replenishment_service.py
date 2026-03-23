from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    AnalysisSalesOrderRow,
    AnalysisBusinessRow,
    AnalysisSourceFile,
    InventoryReplenishmentSetting,
    InventorySnapshotRow,
    ProductCost,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
)

COUNTRY_ALIASES = {
    "US": "US",
    "USA": "US",
    "美国": "US",
    "美国站": "US",
    "DE": "DE",
    "GERMANY": "DE",
    "德国": "DE",
    "德国站": "DE",
    "UK": "UK",
    "GB": "UK",
    "UNITED KINGDOM": "UK",
    "英国": "UK",
    "英国站": "UK",
}
ALLOWED_COUNTRIES = {"US", "DE", "UK"}

DEFAULT_PRODUCTION_LEAD_DAYS = 20
DEFAULT_SHIPPING_DAYS = 25
DEFAULT_SAFETY_FACTOR = Decimal("0.20")
RECENT_SALES_LAG_DAYS = 2
RECENT_SALES_WINDOW_DAYS = 3
IN_TRANSIT_STATUSES = ("in_transit", "draft")
RISK_LONG_TERM_OUT_OF_STOCK = "长期断货"
RISK_SHORT_TERM_OUT_OF_STOCK = "短期断货"
RISK_OUT_OF_STOCK = "断货风险"
RISK_HEALTHY = "健康库存"
RISK_SLOW_MOVING = "滞销"
RISK_SEVERE_SLOW_MOVING = "严重滞销"
RISK_PENDING = "待补数据"


@dataclass
class _BaseSkuRow:
    sku: str
    asin: str | None
    country: str


def _normalize_text(value: str | None, *, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if max_length is not None:
        return normalized[:max_length]
    return normalized


def _normalize_identity(value: str | None) -> str:
    return (value or "").strip().lower()


def _normalize_country(value: str | None) -> str:
    normalized = (value or "").strip().upper()
    if not normalized:
        return "US"
    mapped = COUNTRY_ALIASES.get(normalized, normalized)
    if mapped not in ALLOWED_COUNTRIES:
        allowed = ", ".join(sorted(ALLOWED_COUNTRIES))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"country must be one of: {allowed}",
        )
    return mapped


def _decimal_to_float(value: Decimal | None, digits: int = 4) -> float | None:
    if value is None:
        return None
    quant = Decimal("1").scaleb(-digits)
    return float(value.quantize(quant, rounding=ROUND_HALF_UP))


def _round_decimal(value: Decimal, digits: int = 4) -> Decimal:
    quant = Decimal("1").scaleb(-digits)
    return value.quantize(quant, rounding=ROUND_HALF_UP)


def _round_decimal_to_int(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


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
    normalized_project_name = _normalize_identity(project.project_name)
    product_rows = db.execute(
        select(ProductCost.sku, ProductCost.asin, ProductCost.country)
        .where(
            func.lower(func.trim(ProductCost.project_name)) == normalized_project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
        .order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())
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
        normalized_country = _normalize_country(row_country)
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


def _load_inventory_map(db: Session, project_id: int, country: str) -> dict[str, int]:
    source = (
        db.execute(
            select(AnalysisSourceFile)
            .where(
                AnalysisSourceFile.project_id == project_id,
                AnalysisSourceFile.report_type == "inventory_report",
                AnalysisSourceFile.country == country,
                AnalysisSourceFile.is_current.is_(True),
            )
            .order_by(AnalysisSourceFile.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if source is None:
        return {}
    rows = db.execute(
        select(
            InventorySnapshotRow.sku,
            func.coalesce(func.sum(InventorySnapshotRow.available_qty), 0),
        )
        .where(InventorySnapshotRow.source_file_id == source.id)
        .group_by(InventorySnapshotRow.sku)
    ).all()
    return {
        _normalize_text(sku, max_length=128) or "": int(quantity or 0)
        for sku, quantity in rows
        if _normalize_text(sku, max_length=128)
    }


def _load_in_transit_map(db: Session, project_id: int, country: str) -> dict[str, int]:
    rows = db.execute(
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
            ShipmentSchedule.shipment_status.in_(IN_TRANSIT_STATUSES),
        )
        .group_by(ShipmentScheduleItem.sku)
    ).all()
    return {
        _normalize_text(sku, max_length=128) or "": int(quantity or 0)
        for sku, quantity in rows
        if _normalize_text(sku, max_length=128)
    }


def _load_asin_to_skus_map(base_rows: list[_BaseSkuRow]) -> dict[str, set[str]]:
    mapping: dict[str, set[str]] = {}
    for row in base_rows:
        normalized_asin = _normalize_identity(row.asin)
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
        normalized_asin = _normalize_identity(asin)
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
    rows = db.execute(
        select(
            AnalysisSalesOrderRow.sku,
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0),
        )
        .join(AnalysisSourceFile, AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSalesOrderRow.is_counted_sales.is_(True),
            AnalysisSalesOrderRow.purchase_date_pt >= since,
            AnalysisSalesOrderRow.purchase_date_pt <= window_end,
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
    # Business rule: if 3D is missing, its weight is fully transferred to 7D.
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


def _subtract_days(base_date_text: str | None, days: int) -> str | None:
    if base_date_text is None:
        return None
    target = date.fromisoformat(base_date_text) - timedelta(days=days)
    return target.isoformat()


def _classify_risk(
    today: date, risk_anchor_date_text: str | None, weighted_dms: Decimal | None
) -> str:
    if weighted_dms is None or weighted_dms <= 0 or risk_anchor_date_text is None:
        return RISK_PENDING
    risk_anchor_date = date.fromisoformat(risk_anchor_date_text)
    days_diff = (risk_anchor_date - today).days
    if days_diff < 0:
        return RISK_LONG_TERM_OUT_OF_STOCK
    if days_diff < 25:
        return RISK_SHORT_TERM_OUT_OF_STOCK
    if days_diff < 45:
        return RISK_OUT_OF_STOCK
    if days_diff <= 90:
        return RISK_HEALTHY
    if days_diff <= 120:
        return RISK_SLOW_MOVING
    return RISK_SEVERE_SLOW_MOVING


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
) -> tuple[list[dict[str, object]], dict[str, int], int, bool]:
    project = _get_project_or_404(db, project_id)
    normalized_country = _normalize_country(country)
    today = date.today()
    base_rows = _load_base_skus(db, project, normalized_country)
    settings_map = _load_settings_map(db, project.id, normalized_country)
    inventory_map = _load_inventory_map(db, project.id, normalized_country)
    in_transit_map = _load_in_transit_map(db, project.id, normalized_country)
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

    keyword_text = (keyword or "").strip().lower()
    normalized_risk = (risk_status or "").strip()
    rows: list[dict[str, object]] = []

    for base_row in base_rows:
        setting = settings_map.get((base_row.sku, base_row.country))
        asin = _normalize_text(
            setting.asin if setting and setting.asin else base_row.asin, max_length=64
        )
        available_inventory = int(inventory_map.get(base_row.sku, 0))
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
        if sellout_date_with_transit is not None:
            replenishment_order_date = _subtract_days(
                sellout_date_with_transit, production_lead_days + shipping_days
            )
            warehouse_entry_date = (
                None
                if replenishment_order_date is None
                else (
                    date.fromisoformat(replenishment_order_date) + timedelta(days=7)
                ).isoformat()
            )
            shipment_order_date = (
                None
                if replenishment_order_date is None
                else (
                    date.fromisoformat(replenishment_order_date)
                    + timedelta(days=production_lead_days)
                ).isoformat()
            )
            risk_anchor_date = sellout_date_with_transit
        risk = _classify_risk(today, risk_anchor_date, weighted_dms)
        estimated_replenishment_quantity = (
            _round_decimal_to_int(
                Decimal(production_lead_days + shipping_days) * weighted_dms
            )
            if weighted_dms is not None
            and risk not in {RISK_SLOW_MOVING, RISK_SEVERE_SLOW_MOVING}
            else None
        )

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

        rows.append(
            {
                "project_id": project.id,
                "project_name": project.project_name,
                "sku": base_row.sku,
                "country": base_row.country,
                "asin": asin,
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
    }
    total = len(rows)
    paged = rows[(page - 1) * page_size : (page - 1) * page_size + page_size + 1]
    has_next = len(paged) > page_size
    return paged[:page_size], summary, total, has_next


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
    operator: str | None,
) -> InventoryReplenishmentSetting:
    project = _get_project_or_404(db, project_id)
    normalized_sku = _normalize_text(sku, max_length=128)
    normalized_country = _normalize_country(country)
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

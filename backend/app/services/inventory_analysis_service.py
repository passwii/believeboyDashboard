from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import re

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, InventorySnapshotRow, ProductCost, Project

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


@dataclass
class _AggregatedRow:
    sku: str
    asin: str | None
    available_qty: int
    age_0_90_qty: int
    age_91_180_qty: int
    age_181_270_qty: int
    age_271_365_qty: int
    age_365_plus_qty: int
    recommended_action: str | None


@dataclass
class _BaseSkuRow:
    sku: str
    asin: str | None
    country: str


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


def _normalize_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text or None


def _normalize_identity(value: str | None) -> str:
    return (value or "").strip().lower()


def _build_aging_status(
    *,
    age_91_180_qty: int,
    age_181_270_qty: int,
    age_271_365_qty: int,
    age_365_plus_qty: int,
) -> str:
    if age_365_plus_qty > 0:
        return "over_aged"
    if age_91_180_qty + age_181_270_qty + age_271_365_qty > 0:
        return "aging"
    return "fresh"


def _translate_recommended_action(raw: str | None) -> str:
    value = _normalize_text(raw)
    if value is None:
        return ""

    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value).lower()
    normalized = re.sub(r"[^a-z0-9]+", "_", normalized).strip("_")
    mapping = {
        "no_action_needed": "无需操作",
        "none": "无需操作",
        "normal": "正常销售",
        "keep_selling": "继续销售",
        "monitor": "持续观察",
        "replenish": "建议补货",
        "restock": "建议补货",
        "go_to_restock": "前往补货",
        "remove": "建议移除",
        "create_removal_order": "创建移除订单",
        "liquidate": "建议清货",
        "clearance": "建议清货",
        "discount": "建议降价促销",
        "promotion": "建议促销",
        "outlet_deal": "建议参加奥特莱斯",
        "create_outlet_deal": "创建奥特莱斯促销",
        "lower_price": "降低价格",
        "edit_listing": "优化链接",
        "advertise_listing": "投放广告",
        "create_shipping_plan": "创建发货计划",
        "no_excess_inventory": "无冗余库存",
        "no_restock_excess_action_required": "无需补货/处理冗余",
    }
    if normalized in mapping:
        return mapping[normalized]
    return ""


def _get_project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def _get_inventory_source(
    db: Session,
    *,
    project_id: int,
    country: str,
    snapshot_at: datetime | None = None,
) -> AnalysisSourceFile | None:
    """
    获取库存快照数据源文件。
    如果指定了 snapshot_at，则查找最接近该时间的快照；
    否则查找业务日期最新的一条。

    Uses report_date as the business date for ordering and filtering, since
    snapshot_at may contain old upload-time values on rows that weren't migrated.
    """
    base_conditions = [
        AnalysisSourceFile.project_id == project_id,
        AnalysisSourceFile.report_type == "inventory_report",
        AnalysisSourceFile.country == country,
        AnalysisSourceFile.report_date.isnot(None),
    ]

    if snapshot_at is not None:
        # Find the latest snapshot on or before snapshot_at
        return (
            db.execute(
                select(AnalysisSourceFile)
                .where(
                    *base_conditions,
                    AnalysisSourceFile.report_date <= snapshot_at.date(),
                )
                .order_by(
                    AnalysisSourceFile.report_date.desc(),
                    AnalysisSourceFile.version.desc(),
                    AnalysisSourceFile.id.desc(),
                )
                .limit(1)
            )
            .scalars()
            .first()
        )
    else:
        # Default: get the latest business-date snapshot
        return (
            db.execute(
                select(AnalysisSourceFile)
                .where(*base_conditions)
                .order_by(
                    AnalysisSourceFile.report_date.desc(),
                    AnalysisSourceFile.version.desc(),
                    AnalysisSourceFile.id.desc(),
                )
                .limit(1)
            )
            .scalars()
            .first()
        )


# 保留原函数用于兼容
def _get_current_inventory_source(
    db: Session,
    *,
    project_id: int,
    country: str,
) -> AnalysisSourceFile | None:
    return _get_inventory_source(
        db, project_id=project_id, country=country, snapshot_at=None
    )


def _load_base_skus(db: Session, project: Project, country: str) -> list[_BaseSkuRow]:
    normalized_project_name = _normalize_identity(project.project_name)
    rows = db.execute(
        select(ProductCost.sku, ProductCost.asin, ProductCost.country)
        .where(
            func.lower(func.trim(ProductCost.project_name)) == normalized_project_name,
            ProductCost.is_active.is_(True),
            ProductCost.country == country,
        )
        .order_by(ProductCost.sort_order.asc(), ProductCost.id.asc())
    ).all()

    result: list[_BaseSkuRow] = []
    seen: set[tuple[str, str]] = set()
    for sku, asin, row_country in rows:
        normalized_sku = _normalize_text(sku)
        if normalized_sku is None:
            continue
        normalized_country = _normalize_country(row_country)
        key = (normalized_sku, normalized_country)
        if key in seen:
            continue
        seen.add(key)
        result.append(
            _BaseSkuRow(
                sku=normalized_sku,
                asin=_normalize_text(asin),
                country=normalized_country,
            )
        )
    return result


def _load_aggregated_rows(
    db: Session,
    *,
    source_file_id: int,
) -> list[_AggregatedRow]:
    rows = db.execute(
        select(
            InventorySnapshotRow.sku,
            InventorySnapshotRow.asin,
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
        .where(InventorySnapshotRow.source_file_id == source_file_id)
        .group_by(InventorySnapshotRow.sku, InventorySnapshotRow.asin)
        .order_by(
            func.lower(func.coalesce(InventorySnapshotRow.sku, "")).asc(),
            func.lower(func.coalesce(InventorySnapshotRow.asin, "")).asc(),
        )
    ).all()

    payload: list[_AggregatedRow] = []
    for row in rows:
        sku = _normalize_text(row.sku)
        if sku is None:
            continue
        payload.append(
            _AggregatedRow(
                sku=sku,
                asin=_normalize_text(row.asin),
                available_qty=int(row.available_qty or 0),
                age_0_90_qty=int(row.age_0_90_qty or 0),
                age_91_180_qty=int(row.age_91_180_qty or 0),
                age_181_270_qty=int(row.age_181_270_qty or 0),
                age_271_365_qty=int(row.age_271_365_qty or 0),
                age_365_plus_qty=int(row.age_365_plus_qty or 0),
                recommended_action=_normalize_text(row.recommended_action),
            )
        )
    return payload


def _row_key(sku: str, asin: str | None) -> tuple[str, str]:
    return (sku, asin or "")


def list_inventory_analysis(
    db: Session,
    *,
    project_id: int,
    country: str,
    snapshot_at: datetime | None = None,
) -> dict[str, object]:
    project = _get_project_or_404(db, project_id)
    normalized_country = _normalize_country(country)
    base_rows = _load_base_skus(db, project, normalized_country)
    source = _get_inventory_source(
        db,
        project_id=project_id,
        country=normalized_country,
        snapshot_at=snapshot_at,
    )
    aggregated_rows = (
        _load_aggregated_rows(db, source_file_id=int(source.id))
        if source is not None
        else []
    )
    aggregated_map = {_row_key(row.sku, row.asin): row for row in aggregated_rows}
    ordered_rows: list[_AggregatedRow] = []
    consumed_keys: set[tuple[str, str]] = set()

    for base_row in base_rows:
        matched = aggregated_map.get(_row_key(base_row.sku, base_row.asin))
        if matched is None:
            matched = next(
                (
                    row
                    for row in aggregated_rows
                    if row.sku == base_row.sku
                    and _row_key(row.sku, row.asin) not in consumed_keys
                ),
                None,
            )
        if matched is not None:
            ordered_rows.append(
                _AggregatedRow(
                    sku=base_row.sku,
                    asin=base_row.asin or matched.asin,
                    available_qty=matched.available_qty,
                    age_0_90_qty=matched.age_0_90_qty,
                    age_91_180_qty=matched.age_91_180_qty,
                    age_181_270_qty=matched.age_181_270_qty,
                    age_271_365_qty=matched.age_271_365_qty,
                    age_365_plus_qty=matched.age_365_plus_qty,
                    recommended_action=matched.recommended_action,
                )
            )
            consumed_keys.add(_row_key(matched.sku, matched.asin))
        else:
            ordered_rows.append(
                _AggregatedRow(
                    sku=base_row.sku,
                    asin=base_row.asin,
                    available_qty=0,
                    age_0_90_qty=0,
                    age_91_180_qty=0,
                    age_181_270_qty=0,
                    age_271_365_qty=0,
                    age_365_plus_qty=0,
                    recommended_action=None,
                )
            )

    for row in aggregated_rows:
        key = _row_key(row.sku, row.asin)
        if key in consumed_keys:
            continue
        ordered_rows.append(row)

    action_options = sorted(
        {row.recommended_action for row in ordered_rows if row.recommended_action}
    )
    items: list[dict[str, object]] = []
    summary = {
        "sku_count": 0,
        "out_of_stock_count": 0,
        "aging_sku_count": 0,
        "over_aged_sku_count": 0,
        "total_available_qty": 0,
        "total_age_0_90_qty": 0,
        "total_age_91_180_qty": 0,
        "total_age_181_270_qty": 0,
        "total_age_271_365_qty": 0,
        "total_age_365_plus_qty": 0,
        "action_type_count": len(action_options),
    }

    for row in ordered_rows:
        stock_status = "out_of_stock" if row.available_qty <= 0 else "in_stock"
        aging_status = _build_aging_status(
            age_91_180_qty=row.age_91_180_qty,
            age_181_270_qty=row.age_181_270_qty,
            age_271_365_qty=row.age_271_365_qty,
            age_365_plus_qty=row.age_365_plus_qty,
        )
        summary["sku_count"] += 1
        if stock_status == "out_of_stock":
            summary["out_of_stock_count"] += 1
        if aging_status in {"aging", "over_aged"}:
            summary["aging_sku_count"] += 1
        if aging_status == "over_aged":
            summary["over_aged_sku_count"] += 1
        summary["total_available_qty"] += row.available_qty
        summary["total_age_0_90_qty"] += row.age_0_90_qty
        summary["total_age_91_180_qty"] += row.age_91_180_qty
        summary["total_age_181_270_qty"] += row.age_181_270_qty
        summary["total_age_271_365_qty"] += row.age_271_365_qty
        summary["total_age_365_plus_qty"] += row.age_365_plus_qty

        items.append(
            {
                "project_id": project.id,
                "project_name": project.project_name,
                "country": normalized_country,
                "sku": row.sku,
                "asin": row.asin,
                "available_qty": row.available_qty,
                "age_0_90_qty": row.age_0_90_qty,
                "age_91_180_qty": row.age_91_180_qty,
                "age_181_270_qty": row.age_181_270_qty,
                "age_271_365_qty": row.age_271_365_qty,
                "age_365_plus_qty": row.age_365_plus_qty,
                "recommended_action": row.recommended_action,
                "recommended_action_label": _translate_recommended_action(
                    row.recommended_action
                ),
                "stock_status": stock_status,
                "aging_status": aging_status,
            }
        )

    return {
        "project_id": project.id,
        "project_name": project.project_name,
        "country": normalized_country,
        "snapshot_at": source.snapshot_at if source is not None else None,
        "summary": summary,
        "action_options": action_options,
        "items": items,
    }

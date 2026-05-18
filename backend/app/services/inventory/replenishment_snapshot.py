"""Inventory replenishment snapshot service.

Business logic for managing inventory replenishment analysis snapshots.
"""
from __future__ import annotations

import time
from datetime import date, UTC

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models import (
    AnalysisSourceFile,
    InventoryReplenishmentSnapshot,
    InventoryReplenishmentSnapshotItem,
    Project,
)
from app.utils.text_utils import normalize_text, normalize_identity
from app.utils.math_utils import decimal_to_float

from app.services.inventory.replenishment import (
    list_inventory_replenishment_analysis,
    _normalize_text as _norm_text,
)


def _get_project_or_404(db: Session, project_id: int) -> Project:
    from fastapi import HTTPException, status
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return project


def _get_snapshot_date(report_date: date | None) -> date:
    return report_date if report_date else date.today()


def create_replenishment_snapshot(
    db: Session,
    *,
    project_id: int,
    country: str,
    name: str | None,
    description: str | None,
    operator: str | None,
) -> InventoryReplenishmentSnapshot:
    """创建补货分析快照

    复用现有计算逻辑，将结果完整存储到快照表。
    """
    start_time = time.time()

    project = _get_project_or_404(db, project_id)

    # 获取当前使用的数据源日期
    inventory_source = db.execute(
        select(AnalysisSourceFile.report_date)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
        )
        .limit(1)
    ).scalar_one_or_none()

    business_source = db.execute(
        select(AnalysisSourceFile.report_date)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "business_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.period_end_date.is_not(None),
        )
        .order_by(AnalysisSourceFile.period_end_date.desc())
        .limit(1)
    ).scalar_one_or_none()

    sales_source = db.execute(
        select(AnalysisSourceFile.report_date)
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "sales_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
        )
        .order_by(AnalysisSourceFile.id.desc())
        .limit(1)
    ).scalar_one_or_none()

    # 执行现有计算逻辑获取完整数据
    rows, summary, total, has_next = list_inventory_replenishment_analysis(
        db,
        project_id=project_id,
        country=country,
        keyword=None,
        risk_status=None,
        in_transit_only=False,
        page=1,
        page_size=99999,
    )

    # 创建快照记录
    snapshot = InventoryReplenishmentSnapshot(
        project_id=project_id,
        project_name=project.project_name,
        country=country,
        snapshot_date=date.today(),
        is_current=True,
        inventory_report_date=inventory_source,
        business_report_date=business_source,
        sales_report_date=sales_source,
        name=normalize_text(name, max_length=255) if name else None,
        description=normalize_text(description, max_length=512) if description else None,
        summary_json=summary,
        row_count=len(rows),
        computation_time_ms=int((time.time() - start_time) * 1000),
        created_by=normalize_text(operator, max_length=255),
    )
    db.add(snapshot)
    db.flush()

    # 批量插入明细
    for idx, row in enumerate(rows):
        item = InventoryReplenishmentSnapshotItem(
            snapshot_id=snapshot.id,
            source_row_no=idx,
            sku=row['sku'],
            asin=row.get('asin'),
            available_inventory=row['available_inventory'],
            in_transit_quantity=row['in_transit_quantity'],
            dms_30=_to_decimal(row['dms_30']),
            dms_14=_to_decimal(row['dms_14']),
            dms_7=_to_decimal(row['dms_7']),
            dms_3=_to_decimal(row['dms_3']),
            base_dms=_to_decimal(row['base_dms']),
            safety_factor=_to_decimal(row['safety_factor']) or _to_decimal(0.2),
            production_lead_days=row['production_lead_days'],
            shipping_days=row['shipping_days'],
            weighted_dms=_to_decimal(row['weighted_dms']),
            sellable_days=_to_decimal(row['sellable_days']),
            sellout_date=row.get('sellout_date'),
            sellout_date_with_transit=row.get('sellout_date_with_transit'),
            replenishment_order_date=row.get('replenishment_order_date'),
            warehouse_entry_date=row.get('warehouse_entry_date'),
            shipment_order_date=row.get('shipment_order_date'),
            estimated_replenishment_quantity=row.get('estimated_replenishment_quantity'),
            risk_status=row['risk_status'],
            risk_anchor_date=row.get('risk_anchor_date'),
        )
        db.add(item)

    # 更新旧快照的 is_current 标记
    db.execute(
        update(InventoryReplenishmentSnapshot)
        .where(
            InventoryReplenishmentSnapshot.project_id == project_id,
            InventoryReplenishmentSnapshot.country == country,
            InventoryReplenishmentSnapshot.id != snapshot.id,
        )
        .values(is_current=False)
    )

    db.commit()
    db.refresh(snapshot)
    return snapshot


def _to_decimal(value) -> "Decimal | None":
    from decimal import Decimal
    if value is None:
        return None
    return Decimal(str(value))


def get_snapshot_detail(
    db: Session,
    snapshot_id: int,
) -> InventoryReplenishmentSnapshot | None:
    """获取快照详情"""
    return db.get(InventoryReplenishmentSnapshot, snapshot_id)


def get_snapshot_items(
    db: Session,
    snapshot_id: int,
) -> list[InventoryReplenishmentSnapshotItem]:
    """获取快照的所有明细"""
    return (
        db.execute(
            select(InventoryReplenishmentSnapshotItem)
            .where(InventoryReplenishmentSnapshotItem.snapshot_id == snapshot_id)
            .order_by(InventoryReplenishmentSnapshotItem.source_row_no.asc())
        )
        .scalars()
        .all()
    )


def list_snapshots(
    db: Session,
    *,
    project_id: int,
    country: str,
    page: int,
    page_size: int,
) -> tuple[list[InventoryReplenishmentSnapshot], int, bool]:
    """列出快照"""
    base_query = (
        select(InventoryReplenishmentSnapshot)
        .where(
            InventoryReplenishmentSnapshot.project_id == project_id,
            InventoryReplenishmentSnapshot.country == country,
        )
    )

    # Count total
    total = db.execute(
        select(func.count()).select_from(base_query.subquery())
    ).scalar() or 0

    # Paginate
    offset = (page - 1) * page_size
    snapshots = (
        db.execute(
            base_query
            .order_by(
                InventoryReplenishmentSnapshot.snapshot_date.desc(),
                InventoryReplenishmentSnapshot.created_at.desc(),
            )
            .offset(offset)
            .limit(page_size + 1)
        )
        .scalars()
        .all()
    )

    has_next = len(snapshots) > page_size
    return list(snapshots[:page_size]), total, has_next


def update_snapshot(
    db: Session,
    *,
    snapshot_id: int,
    name: str | None,
    description: str | None,
    operator: str | None,
) -> InventoryReplenishmentSnapshot:
    """更新快照的名称和备注"""
    snapshot = db.get(InventoryReplenishmentSnapshot, snapshot_id)
    if snapshot is None:
        raise ValueError("快照不存在")

    if name is not None:
        snapshot.name = normalize_text(name, max_length=255)
    if description is not None:
        snapshot.description = normalize_text(description, max_length=512)

    db.commit()
    db.refresh(snapshot)
    return snapshot


def delete_snapshot(
    db: Session,
    snapshot_id: int,
) -> bool:
    """删除快照"""
    snapshot = db.get(InventoryReplenishmentSnapshot, snapshot_id)
    if snapshot is None:
        return False
    db.delete(snapshot)
    db.commit()
    return True


def cleanup_old_snapshots(
    db: Session,
    *,
    project_id: int,
    country: str,
    keep_count: int,
) -> int:
    """清理旧快照，保留最近的 N 个"""
    # 获取需要保留的快照ID
    keep_snapshots = (
        db.execute(
            select(InventoryReplenishmentSnapshot.id)
            .where(
                InventoryReplenishmentSnapshot.project_id == project_id,
                InventoryReplenishmentSnapshot.country == country,
            )
            .order_by(
                InventoryReplenishmentSnapshot.snapshot_date.desc(),
                InventoryReplenishmentSnapshot.created_at.desc(),
            )
            .limit(keep_count)
        )
        .scalars()
        .all()
    )

    keep_ids = [s.id for s in keep_snapshots]

    # 删除不在保留列表中的快照
    delete_count = db.execute(
        select(func.count()).select_from(InventoryReplenishmentSnapshot)
        .where(
            InventoryReplenishmentSnapshot.project_id == project_id,
            InventoryReplenishmentSnapshot.country == country,
            ~InventoryReplenishmentSnapshot.id.in_(keep_ids) if keep_ids else False,
        )
    ).scalar() or 0

    if keep_ids:
        db.execute(
            update(InventoryReplenishmentSnapshot)
            .where(
                InventoryReplenishmentSnapshot.project_id == project_id,
                InventoryReplenishmentSnapshot.country == country,
                ~InventoryReplenishmentSnapshot.id.in_(keep_ids),
            )
            .values(is_current=False)
        )
    else:
        # 没有可保留的快照，删除全部
        pass

    db.commit()
    return int(delete_count)
"""Inventory replenishment snapshot endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.services import project_service
from app.services.inventory.replenishment_snapshot import (
    create_replenishment_snapshot,
    delete_snapshot,
    get_snapshot_detail,
    get_snapshot_items,
    list_snapshots,
    update_snapshot,
)
from app.schemas.inventory_replenishment_snapshot import (
    InventoryReplenishmentSnapshotListItem,
    InventoryReplenishmentSnapshotDetail,
    InventoryReplenishmentSnapshotItemSchema,
    InventoryReplenishmentSnapshotSummary,
    CreateSnapshotRequest,
    UpdateSnapshotRequest,
)
from app.schemas.inventory_replenishment import (
    InventoryReplenishmentListResponse,
    InventoryReplenishmentListItem,
    InventoryReplenishmentSummary,
)
from app.services.audit_log_service import (
    append_operation_audit_log,
)

router = APIRouter(prefix="/inventory-replenishment-snapshots", dependencies=[Depends(protected)])


def _to_summary(summary_json: dict) -> InventoryReplenishmentSnapshotSummary:
    return InventoryReplenishmentSnapshotSummary(
        sku_count=summary_json.get('sku_count', 0),
        out_of_stock_risk_count=summary_json.get('out_of_stock_risk_count', 0),
        healthy_count=summary_json.get('healthy_count', 0),
        slow_moving_count=summary_json.get('slow_moving_count', 0),
        pending_data_count=summary_json.get('pending_data_count', 0),
        total_available_inventory=summary_json.get('total_available_inventory', 0),
        total_in_transit_quantity=summary_json.get('total_in_transit_quantity', 0),
    )


def _to_list_item(snapshot) -> InventoryReplenishmentSnapshotListItem:
    return InventoryReplenishmentSnapshotListItem(
        id=snapshot.id,
        project_id=snapshot.project_id,
        project_name=snapshot.project_name,
        country=snapshot.country,
        snapshot_date=snapshot.snapshot_date,
        is_current=snapshot.is_current,
        name=snapshot.name,
        description=snapshot.description,
        inventory_report_date=snapshot.inventory_report_date,
        business_report_date=snapshot.business_report_date,
        sales_report_date=snapshot.sales_report_date,
        row_count=snapshot.row_count,
        created_by=snapshot.created_by,
        created_at=snapshot.created_at.isoformat() if snapshot.created_at else '',
        summary=_to_summary(snapshot.summary_json) if snapshot.summary_json else InventoryReplenishmentSnapshotSummary(
            sku_count=0,
            out_of_stock_risk_count=0,
            healthy_count=0,
            slow_moving_count=0,
            pending_data_count=0,
            total_available_inventory=0,
            total_in_transit_quantity=0,
        ),
    )


@router.post("", response_model=InventoryReplenishmentSnapshotDetail)
def create_snapshot(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    payload: CreateSnapshotRequest | None = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentSnapshotDetail:
    """创建库存补货分析快照"""
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    name = payload.name if payload else None
    description = payload.description if payload else None

    snapshot = create_replenishment_snapshot(
        db,
        project_id=project_id,
        country=country,
        name=name,
        description=description,
        operator=operator,
    )

    append_operation_audit_log(
        db,
        action="inventory_replenishment_snapshot.create",
        target_type="inventory_replenishment_snapshot",
        target_id=snapshot.id,
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "name": name,
            "row_count": snapshot.row_count,
        },
        request=request,
    )
    db.commit()

    # 获取明细
    items = get_snapshot_items(db, snapshot.id)
    snapshot_items = [
        InventoryReplenishmentSnapshotItemSchema(
            source_row_no=item.source_row_no,
            sku=item.sku,
            asin=item.asin,
            available_inventory=item.available_inventory,
            in_transit_quantity=item.in_transit_quantity,
            dms_30=float(item.dms_30) if item.dms_30 else None,
            dms_14=float(item.dms_14) if item.dms_14 else None,
            dms_7=float(item.dms_7) if item.dms_7 else None,
            dms_3=float(item.dms_3) if item.dms_3 else None,
            base_dms=float(item.base_dms) if item.base_dms else None,
            safety_factor=float(item.safety_factor) if item.safety_factor else 0.0,
            production_lead_days=item.production_lead_days,
            shipping_days=item.shipping_days,
            weighted_dms=float(item.weighted_dms) if item.weighted_dms else None,
            sellable_days=float(item.sellable_days) if item.sellable_days else None,
            sellout_date=item.sellout_date,
            sellout_date_with_transit=item.sellout_date_with_transit,
            replenishment_order_date=item.replenishment_order_date,
            warehouse_entry_date=item.warehouse_entry_date,
            shipment_order_date=item.shipment_order_date,
            estimated_replenishment_quantity=item.estimated_replenishment_quantity,
            risk_status=item.risk_status,
            risk_anchor_date=item.risk_anchor_date,
        )
        for item in items
    ]

    return InventoryReplenishmentSnapshotDetail(
        id=snapshot.id,
        project_id=snapshot.project_id,
        project_name=snapshot.project_name,
        country=snapshot.country,
        snapshot_date=snapshot.snapshot_date,
        is_current=snapshot.is_current,
        name=snapshot.name,
        description=snapshot.description,
        inventory_report_date=snapshot.inventory_report_date,
        business_report_date=snapshot.business_report_date,
        sales_report_date=snapshot.sales_report_date,
        row_count=snapshot.row_count,
        created_by=snapshot.created_by,
        created_at=snapshot.created_at.isoformat() if snapshot.created_at else '',
        summary=_to_summary(snapshot.summary_json),
        items=snapshot_items,
    )


@router.get("", response_model=list[InventoryReplenishmentSnapshotListItem])
def list_snapshots_endpoint(
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db_session),
) -> list[InventoryReplenishmentSnapshotListItem]:
    """获取快照列表"""
    snapshots, total, has_next = list_snapshots(
        db,
        project_id=project_id,
        country=country,
        page=page,
        page_size=page_size,
    )
    return [_to_list_item(s) for s in snapshots]


@router.get("/{snapshot_id}", response_model=InventoryReplenishmentSnapshotDetail)
def get_snapshot_endpoint(
    snapshot_id: int,
    db: Session = Depends(get_db_session),
) -> InventoryReplenishmentSnapshotDetail:
    """获取快照详情（包含完整数据）"""
    snapshot = get_snapshot_detail(db, snapshot_id)
    if snapshot is None:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    items = get_snapshot_items(db, snapshot_id)
    snapshot_items = [
        InventoryReplenishmentSnapshotItemSchema(
            source_row_no=item.source_row_no,
            sku=item.sku,
            asin=item.asin,
            available_inventory=item.available_inventory,
            in_transit_quantity=item.in_transit_quantity,
            dms_30=float(item.dms_30) if item.dms_30 else None,
            dms_14=float(item.dms_14) if item.dms_14 else None,
            dms_7=float(item.dms_7) if item.dms_7 else None,
            dms_3=float(item.dms_3) if item.dms_3 else None,
            base_dms=float(item.base_dms) if item.base_dms else None,
            safety_factor=float(item.safety_factor) if item.safety_factor else 0.0,
            production_lead_days=item.production_lead_days,
            shipping_days=item.shipping_days,
            weighted_dms=float(item.weighted_dms) if item.weighted_dms else None,
            sellable_days=float(item.sellable_days) if item.sellable_days else None,
            sellout_date=item.sellout_date,
            sellout_date_with_transit=item.sellout_date_with_transit,
            replenishment_order_date=item.replenishment_order_date,
            warehouse_entry_date=item.warehouse_entry_date,
            shipment_order_date=item.shipment_order_date,
            estimated_replenishment_quantity=item.estimated_replenishment_quantity,
            risk_status=item.risk_status,
            risk_anchor_date=item.risk_anchor_date,
        )
        for item in items
    ]

    return InventoryReplenishmentSnapshotDetail(
        id=snapshot.id,
        project_id=snapshot.project_id,
        project_name=snapshot.project_name,
        country=snapshot.country,
        snapshot_date=snapshot.snapshot_date,
        is_current=snapshot.is_current,
        name=snapshot.name,
        description=snapshot.description,
        inventory_report_date=snapshot.inventory_report_date,
        business_report_date=snapshot.business_report_date,
        sales_report_date=snapshot.sales_report_date,
        row_count=snapshot.row_count,
        created_by=snapshot.created_by,
        created_at=snapshot.created_at.isoformat() if snapshot.created_at else '',
        summary=_to_summary(snapshot.summary_json),
        items=snapshot_items,
    )


@router.get("/{snapshot_id}/items", response_model=InventoryReplenishmentListResponse)
def get_snapshot_items_endpoint(
    snapshot_id: int,
    keyword: str | None = Query(default=None),
    risk_status: str | None = Query(default=None),
    in_transit_only: bool = Query(default=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db_session),
) -> InventoryReplenishmentListResponse:
    """获取快照的明细数据（兼容原列表接口格式）"""
    snapshot = get_snapshot_detail(db, snapshot_id)
    if snapshot is None:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    items = get_snapshot_items(db, snapshot_id)

    # 应用筛选
    filtered_items = items
    keyword_text = (keyword or "").strip().lower()
    if keyword_text:
        filtered_items = [
            item for item in filtered_items
            if keyword_text in item.sku.lower() or (item.asin and keyword_text in item.asin.lower())
        ]

    normalized_risk = (risk_status or "").strip()
    if normalized_risk and normalized_risk != "all":
        filtered_items = [
            item for item in filtered_items
            if item.risk_status == normalized_risk
        ]

    if in_transit_only:
        filtered_items = [
            item for item in filtered_items
            if item.in_transit_quantity > 0
        ]

    # 分页
    total = len(filtered_items)
    offset = (page - 1) * page_size
    paged_items = filtered_items[offset:offset + page_size]
    has_next = offset + page_size < total

    # 转换为列表格式
    list_items = [
        InventoryReplenishmentListItem(
            project_id=snapshot.project_id,
            project_name=snapshot.project_name,
            sku=item.sku,
            country=snapshot.country,
            asin=item.asin,
            available_inventory=item.available_inventory,
            in_transit_quantity=item.in_transit_quantity,
            dms_30=float(item.dms_30) if item.dms_30 else None,
            dms_14=float(item.dms_14) if item.dms_14 else None,
            dms_7=float(item.dms_7) if item.dms_7 else None,
            dms_3=float(item.dms_3) if item.dms_3 else None,
            base_dms=float(item.base_dms) if item.base_dms else None,
            safety_factor=float(item.safety_factor) if item.safety_factor else 0.0,
            weighted_dms=float(item.weighted_dms) if item.weighted_dms else None,
            sellable_days=float(item.sellable_days) if item.sellable_days else None,
            sellout_date=item.sellout_date,
            sellout_date_with_transit=item.sellout_date_with_transit,
            production_lead_days=item.production_lead_days,
            shipping_days=item.shipping_days,
            replenishment_order_date=item.replenishment_order_date,
            warehouse_entry_date=item.warehouse_entry_date,
            shipment_order_date=item.shipment_order_date,
            estimated_replenishment_quantity=item.estimated_replenishment_quantity,
            risk_status=item.risk_status,
            risk_anchor_date=item.risk_anchor_date,
        )
        for item in paged_items
    ]

    # 从 summary_json 获取汇总
    summary = _to_summary(snapshot.summary_json)

    return InventoryReplenishmentListResponse(
        items=list_items,
        summary=InventoryReplenishmentSummary(
            sku_count=summary.sku_count,
            out_of_stock_risk_count=summary.out_of_stock_risk_count,
            healthy_count=summary.healthy_count,
            slow_moving_count=summary.slow_moving_count,
            pending_data_count=summary.pending_data_count,
            total_available_inventory=summary.total_available_inventory,
            total_in_transit_quantity=summary.total_in_transit_quantity,
        ),
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )


@router.patch("/{snapshot_id}", response_model=InventoryReplenishmentSnapshotListItem)
def update_snapshot_endpoint(
    request: Request,
    snapshot_id: int,
    payload: UpdateSnapshotRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentSnapshotListItem:
    """更新快照名称或备注（仅管理员）"""
    if not is_admin:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可修改快照")

    snapshot = get_snapshot_detail(db, snapshot_id)
    if snapshot is None:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    updated = update_snapshot(
        db,
        snapshot_id=snapshot_id,
        name=payload.name,
        description=payload.description,
        operator=operator,
    )

    append_operation_audit_log(
        db,
        action="inventory_replenishment_snapshot.update",
        target_type="inventory_replenishment_snapshot",
        target_id=snapshot_id,
        operator=operator,
        after={
            "snapshot_id": snapshot_id,
            "name": updated.name,
            "description": updated.description,
        },
        request=request,
    )
    db.commit()

    return _to_list_item(updated)


@router.delete("/{snapshot_id}")
def delete_snapshot_endpoint(
    request: Request,
    snapshot_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    """删除快照（仅管理员）"""
    if not is_admin:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅管理员可删除快照")

    snapshot = get_snapshot_detail(db, snapshot_id)
    if snapshot is None:
        from fastapi import HTTPException, status
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    success = delete_snapshot(db, snapshot_id)
    if success:
        append_operation_audit_log(
            db,
            action="inventory_replenishment_snapshot.delete",
            target_type="inventory_replenishment_snapshot",
            target_id=snapshot_id,
            operator=operator,
            after={"snapshot_id": snapshot_id, "project_id": snapshot.project_id},
            request=request,
        )
        db.commit()

    return {"success": success, "snapshot_id": snapshot_id}
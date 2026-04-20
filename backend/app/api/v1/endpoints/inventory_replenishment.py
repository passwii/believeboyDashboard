from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.models import AnalysisSourceFile
from app.schemas.inventory_replenishment import (
    InventoryAnalysisItem,
    InventoryAnalysisResponse,
    InventoryAnalysisSummary,
    InventoryReplenishmentListItem,
    InventoryReplenishmentListResponse,
    InventoryReplenishmentSettingItem,
    InventoryReplenishmentSettingUpdate,
    InventoryReplenishmentShipmentItem,
    InventoryReplenishmentShipmentResponse,
    InventoryReplenishmentSummary,
)
from app.services import (
    inventory_analysis_service,
    inventory_replenishment_service,
    project_service,
)
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)
from app.schemas.inventory_replenishment import InventorySnapshotOption

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/inventory-analysis", response_model=InventoryAnalysisResponse)
def get_inventory_analysis(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    snapshot_at: datetime | None = Query(
        default=None,
        description="筛选特定快照时间的库存数据，格式: YYYY-MM-DD 或 YYYY-MM-DDTHH:MM:SS",
    ),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryAnalysisResponse:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    payload = inventory_analysis_service.list_inventory_analysis(
        db,
        project_id=project_id,
        country=country,
        snapshot_at=snapshot_at,
    )
    append_operation_view_log(
        db,
        action="inventory_analysis.view",
        target_type="inventory_analysis",
        target_id=project_id,
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "snapshot_at": str(snapshot_at) if snapshot_at else "current",
            "item_count": len(payload["items"]),
        },
        request=request,
    )
    db.commit()
    return InventoryAnalysisResponse(
        project_id=int(payload["project_id"]),
        project_name=str(payload["project_name"]),
        country=str(payload["country"]),
        snapshot_at=payload["snapshot_at"],
        summary=InventoryAnalysisSummary(**payload["summary"]),
        action_options=[str(item) for item in payload["action_options"]],
        items=[InventoryAnalysisItem(**item) for item in payload["items"]],
    )


@router.get(
    "/inventory-snapshot-options",
    response_model=list[InventorySnapshotOption],
)
def list_inventory_snapshot_options(
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_db_session),
) -> list[InventorySnapshotOption]:
    from sqlalchemy import select

    from sqlalchemy import func

    rows = db.execute(
        select(
            func.date(AnalysisSourceFile.snapshot_at).label("snapshot_date"),
            func.max(AnalysisSourceFile.snapshot_at).label("latest_snapshot_at"),
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == "inventory_report",
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.snapshot_at.isnot(None),
        )
        .group_by(func.date(AnalysisSourceFile.snapshot_at))
        .order_by(func.date(AnalysisSourceFile.snapshot_at).desc())
    ).all()

    return [
        InventorySnapshotOption(snapshot_at=row.latest_snapshot_at, is_current=False)
        for row in rows
    ]


@router.get(
    "/inventory-replenishment-analysis",
    response_model=InventoryReplenishmentListResponse,
)
def list_inventory_replenishment_analysis(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    keyword: str | None = Query(default=None),
    risk_status: str | None = Query(default=None),
    in_transit_only: bool = Query(default=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentListResponse:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    rows, summary, total, has_next = (
        inventory_replenishment_service.list_inventory_replenishment_analysis(
            db,
            project_id=project_id,
            country=country,
            keyword=keyword,
            risk_status=risk_status,
            in_transit_only=in_transit_only,
            page=page,
            page_size=page_size,
        )
    )
    append_operation_view_log(
        db,
        action="inventory_replenishment.list",
        target_type="inventory_replenishment",
        target_id=project_id,
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "keyword": keyword,
            "risk_status": risk_status,
            "in_transit_only": in_transit_only,
            "page": page,
            "page_size": page_size,
            "count": len(rows),
            "total": total,
        },
        request=request,
    )
    db.commit()
    return InventoryReplenishmentListResponse(
        items=[InventoryReplenishmentListItem(**row) for row in rows],
        summary=InventoryReplenishmentSummary(**summary),
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )


@router.put(
    "/inventory-replenishment-settings/{project_id}/{sku:path}",
    response_model=InventoryReplenishmentSettingItem,
)
def update_inventory_replenishment_setting(
    project_id: int,
    sku: str,
    payload: InventoryReplenishmentSettingUpdate,
    request: Request,
    country: str = Query(default="US"),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentSettingItem:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    row = inventory_replenishment_service.upsert_inventory_replenishment_setting(
        db,
        project_id=project_id,
        sku=sku,
        country=country,
        asin=payload.asin,
        production_lead_days=payload.production_lead_days,
        shipping_days=payload.shipping_days,
        safety_factor=payload.safety_factor,
        operator=operator,
    )
    append_operation_audit_log(
        db,
        action="inventory_replenishment_settings.upsert",
        target_type="inventory_replenishment_setting",
        target_id=row.id,
        operator=operator,
        after={
            "project_id": row.project_id,
            "sku": row.sku,
            "country": row.country,
            "asin": row.asin,
            "production_lead_days": row.production_lead_days,
            "shipping_days": row.shipping_days,
            "safety_factor": float(row.safety_factor),
        },
        request=request,
    )
    db.commit()
    return InventoryReplenishmentSettingItem(
        project_id=int(row.project_id),
        project_name=str(row.project_name),
        sku=str(row.sku),
        country=str(row.country),
        asin=row.asin,
        production_lead_days=int(row.production_lead_days),
        shipping_days=int(row.shipping_days),
        safety_factor=float(row.safety_factor),
    )


@router.get(
    "/inventory-replenishment-shipments",
    response_model=InventoryReplenishmentShipmentResponse,
)
def list_inventory_replenishment_shipments(
    request: Request,
    project_id: int = Query(gt=0),
    sku: str = Query(min_length=1),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentShipmentResponse:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    rows = inventory_replenishment_service.list_inventory_replenishment_shipments(
        db,
        project_id=project_id,
        sku=sku,
    )
    append_operation_view_log(
        db,
        action="inventory_replenishment.shipments.view",
        target_type="inventory_replenishment",
        target_id=project_id,
        operator=operator,
        after={"project_id": project_id, "sku": sku, "count": len(rows)},
        request=request,
    )
    db.commit()
    return InventoryReplenishmentShipmentResponse(
        project_id=project_id,
        sku=sku,
        items=[InventoryReplenishmentShipmentItem(**row) for row in rows],
    )

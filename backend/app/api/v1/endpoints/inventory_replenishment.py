from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Header, Query, Request
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.models import AnalysisSourceFile
from sqlalchemy import func, select
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
    project_service,
)
from app.services.inventory.replenishment import (
    list_inventory_replenishment_analysis,
    list_inventory_replenishment_shipments,
    list_snapshot_options,
    upsert_inventory_replenishment_setting,
)
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)
from app.schemas.inventory_replenishment import InventorySnapshotOption, CalendarRowItem, CalendarResponse

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/inventory-analysis", response_model=InventoryAnalysisResponse)
def get_inventory_analysis(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    report_date: date | None = Query(
        default=None,
        description="筛选特定业务日期的库存数据，格式: YYYY-MM-DD",
    ),
    db: Session = Depends(get_read_db_session),
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
        report_date=report_date,
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
            "report_date": str(report_date) if report_date else "current",
            "item_count": len(payload["items"]),
        },
        request=request,
    )
    db.commit()
    return InventoryAnalysisResponse(
        project_id=int(payload["project_id"]),
        project_name=str(payload["project_name"]),
        country=str(payload["country"]),
        report_date=payload["report_date"],
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
    db: Session = Depends(get_read_db_session),
) -> list[InventorySnapshotOption]:
    options = list_snapshot_options(db, project_id=project_id, country=country)
    return [
        InventorySnapshotOption(report_date=row["report_date"], is_current=row["is_current"])
        for row in options
    ]


@router.get(
    "/inventory-replenishment-analysis",
    response_model=InventoryReplenishmentListResponse,
)
def list_inventory_replenishment_analysis_endpoint(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    keyword: str | None = Query(default=None),
    risk_status: str | None = Query(default=None),
    in_transit_only: bool = Query(default=False),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_read_db_session),
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
        list_inventory_replenishment_analysis(
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
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentSettingItem:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    row = upsert_inventory_replenishment_setting(
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
def list_inventory_replenishment_shipments_endpoint(
    request: Request,
    project_id: int = Query(gt=0),
    sku: str = Query(min_length=1),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> InventoryReplenishmentShipmentResponse:
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    rows = list_inventory_replenishment_shipments(
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


@router.get(
    "/inventory-replenishment-calendar",
    response_model=CalendarResponse,
)
def list_inventory_replenishment_calendar(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    risk_status: str | None = Query(default=None),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> CalendarResponse:
    from datetime import date as DateType, timedelta
    from app.services.inventory.replenishment import list_inventory_replenishment_analysis

    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    today = DateType.today()
    today_str = today.isoformat()

    rows, _, total, has_next = list_inventory_replenishment_analysis(
        db,
        project_id=project_id,
        country=country,
        keyword=None,
        risk_status=risk_status,
        in_transit_only=False,
        page=page,
        page_size=page_size,
    )

    SLOW_MOVING_STATUSES = {"滞销", "严重滞销"}
    CRITICAL_STATUSES = {"长期断货", "短期断货", "断货风险"}

    calendar_items = []
    for row in rows:
        sellout_date = row.get("sellout_date_with_transit") or row.get("sellout_date")

        if sellout_date:
            sellout_date_obj = DateType.fromisoformat(sellout_date) if isinstance(sellout_date, str) else sellout_date
            if date_from and sellout_date_obj < date_from:
                continue
            if date_to and sellout_date_obj > date_to:
                continue

        risk = row.get("risk_status", "")
        is_slow = risk in SLOW_MOVING_STATUSES
        is_crit = risk in CRITICAL_STATUSES

        calendar_items.append(CalendarRowItem(
            project_id=row["project_id"],
            project_name=row["project_name"],
            sku=row["sku"],
            country=row["country"],
            risk_status=risk,
            today=today_str,
            sellout_date=sellout_date,
            order_date=row.get("replenishment_order_date"),
            warehouse_entry_date=row.get("warehouse_entry_date"),
            available_inventory=row.get("available_inventory", 0),
            in_transit_quantity=row.get("in_transit_quantity", 0),
            weighted_dms=row.get("weighted_dms"),
            estimated_quantity=row.get("estimated_replenishment_quantity"),
            is_slow_moving=is_slow,
            is_critical=is_crit,
        ))

    append_operation_view_log(
        db,
        action="inventory_replenishment.calendar.view",
        target_type="inventory_replenishment",
        target_id=project_id,
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "risk_status": risk_status,
            "date_from": str(date_from) if date_from else None,
            "date_to": str(date_to) if date_to else None,
            "page": page,
            "page_size": page_size,
            "count": len(calendar_items),
            "total": total,
        },
        request=request,
    )
    db.commit()

    return CalendarResponse(
        items=calendar_items,
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )

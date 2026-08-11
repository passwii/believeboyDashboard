from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
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
    SeasonalReplenishmentListItem,
    SeasonalReplenishmentListResponse,
)
from app.services import (
    inventory_analysis_service,
    project_service,
)
from app.services.infra.inventory_cache import (
    get_inventory_analysis_cache,
    set_inventory_analysis_cache,
    get_inventory_snapshot_options_cache,
    set_inventory_snapshot_options_cache,
    get_inventory_replenishment_cache,
    set_inventory_replenishment_cache,
    invalidate_inventory_analysis_cache,
    invalidate_inventory_snapshot_options_cache,
    invalidate_inventory_replenishment_cache,
)
from app.services.inventory.replenishment import (
    list_inventory_replenishment_analysis,
    list_inventory_replenishment_shipments,
    list_seasonal_replenishment_analysis,
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

    # ── Redis cache: 5 min TTL, keyed by project+country+date ──
    report_date_str = str(report_date) if report_date else None
    cached = get_inventory_analysis_cache(project_id, country, report_date_str)
    if cached is not None:
        return InventoryAnalysisResponse(**cached)

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

    response = InventoryAnalysisResponse(
        project_id=int(payload["project_id"]),
        project_name=str(payload["project_name"]),
        country=str(payload["country"]),
        report_date=payload["report_date"],
        summary=InventoryAnalysisSummary(**payload["summary"]),
        action_options=[str(item) for item in payload["action_options"]],
        items=[InventoryAnalysisItem(**item) for item in payload["items"]],
    )
    set_inventory_analysis_cache(
        project_id, country, report_date_str, response.model_dump(mode="json")
    )
    return response


@router.get(
    "/inventory-snapshot-options",
    response_model=list[InventorySnapshotOption],
)
def list_inventory_snapshot_options(
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_read_db_session),
) -> list[InventorySnapshotOption]:
    # ── Redis cache: 10 min TTL ──
    cached = get_inventory_snapshot_options_cache(project_id, country)
    if cached is not None:
        return [InventorySnapshotOption(**row) for row in cached]

    options = list_snapshot_options(db, project_id=project_id, country=country)
    result = [
        InventorySnapshotOption(report_date=row["report_date"], is_current=row["is_current"])
        for row in options
    ]
    set_inventory_snapshot_options_cache(
        project_id, country, [r.model_dump(mode="json") for r in result]
    )
    return result


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

    # ── Redis cache: 5 min TTL ──
    cached = get_inventory_replenishment_cache(
        project_id, country, keyword, risk_status, in_transit_only, page, page_size
    )
    if cached is not None:
        return InventoryReplenishmentListResponse(**cached)

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
    response = InventoryReplenishmentListResponse(
        items=[InventoryReplenishmentListItem(**row) for row in rows],
        summary=InventoryReplenishmentSummary(**summary),
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
    )
    set_inventory_replenishment_cache(
        project_id, country, keyword, risk_status, in_transit_only, page, page_size,
        response.model_dump(mode="json"),
    )
    return response


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
        target_days=payload.target_days,
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
            "target_days": int(row.target_days),
        },
        request=request,
    )
    db.commit()
    # BLF-633: 设置写路径未失效补货分析缓存 → 保存/刷新重算最长 5 分钟返回旧值
    invalidate_inventory_replenishment_cache(project_id)
    return InventoryReplenishmentSettingItem(
        project_id=int(row.project_id),
        project_name=str(row.project_name),
        sku=str(row.sku),
        country=str(row.country),
        asin=row.asin,
        production_lead_days=int(row.production_lead_days),
        shipping_days=int(row.shipping_days),
        safety_factor=float(row.safety_factor),
        target_days=int(row.target_days),
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


@router.get(
    "/seasonal-replenishment-analysis",
    response_model=SeasonalReplenishmentListResponse,
)
def list_seasonal_replenishment_analysis_endpoint(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    from_date: date = Query(
        ...,
        description="历史窗口左端，YYYY-MM-DD；与 to_date 一起决定加权 DMS 窗口",
    ),
    to_date: date = Query(
        ...,
        description="历史窗口右端（同时作为售卖截止/可售天数的锚点），YYYY-MM-DD",
    ),
    compare_year_offset: int = Query(
        default=0,
        ge=0,
        le=2,
        description="0=关闭去年同期，1=去年同期，2=前年同期",
    ),
    keyword: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> SeasonalReplenishmentListResponse:
    """季节性补货分析接口。

    与 ``/inventory-replenishment-analysis`` 的区别：
      - 销量窗口由 ``from_date`` / ``to_date`` 决定（不是 date.today()）
      - 加权权重 90D×40% + 30D×30% + 14D×20% + 7D×10%
      - 不判定 risk_status
      - 可选去年同期对比（``compare_year_offset``）
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    if to_date < from_date:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="to_date 必须 ≥ from_date",
        )
    if (to_date - from_date).days < 7:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="日期范围跨度至少 7 天",
        )

    rows, summary, total, has_next = list_seasonal_replenishment_analysis(
        db,
        project_id=project_id,
        country=country,
        from_date=from_date,
        to_date=to_date,
        compare_year_offset=compare_year_offset,
        keyword=keyword,
        page=page,
        page_size=page_size,
    )
    append_operation_view_log(
        db,
        action="inventory_replenishment.seasonal.view",
        target_type="inventory_replenishment",
        target_id=project_id,
        operator=operator,
        after={
            "project_id": project_id,
            "country": country,
            "from_date": str(from_date),
            "to_date": str(to_date),
            "compare_year_offset": compare_year_offset,
            "keyword": keyword,
            "page": page,
            "page_size": page_size,
            "count": len(rows),
            "total": total,
        },
        request=request,
    )
    db.commit()
    return SeasonalReplenishmentListResponse(
        items=[SeasonalReplenishmentListItem(**row) for row in rows],
        summary=InventoryReplenishmentSummary(**summary),
        page=page,
        page_size=page_size,
        total=total,
        has_next=has_next,
        from_date=from_date,
        to_date=to_date,
        compare_year_offset=compare_year_offset,
    )

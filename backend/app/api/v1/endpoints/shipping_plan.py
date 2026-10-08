from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.models import ShippingPlanBatch, ShippingPlanItem
from app.schemas.shipping_plan import (
    ShipmentHistoryResponse,
    ShippingPlanAllocationCreate,
    ShippingPlanAllocationResult,
    ShippingPlanBatchCreate,
    ShippingPlanBatchListResponse,
    ShippingPlanBatchResponse,
    ShippingPlanBatchUpdate,
    ShippingPlanForecastResponse,
    ShippingPlanGrowthFactorResponse,
    ShippingPlanGrowthFactorUpdate,
    ShippingPlanSkuListResponse,
)
from app.services import project_service
from app.services.audit_log_service import (
    append_operation_audit_log,
    append_operation_view_log,
)
from app.services.shipping_plan import service

router = APIRouter(
    prefix="/shipping-plan",
    tags=["shipping-plan"],
    dependencies=[Depends(protected)],
)


def _ensure_project_access(db: Session, project_id: int, operator: str | None, is_admin: bool) -> None:
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=is_admin)


@router.get("/skus", response_model=ShippingPlanSkuListResponse)
def get_shipping_plan_skus(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    as_of_date: date = Query(default_factory=date.today),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    result = service.list_shipping_plan_skus(
        db, project_id=project_id, country=country, as_of_date=as_of_date, page=page, page_size=page_size
    )
    append_operation_view_log(db, action="shipping_plan.skus.view", target_type="shipping_plan", target_id=project_id, operator=operator, after={"country": country, "count": len(result["items"])}, request=request)
    db.commit()
    return result


@router.get("/forecast", response_model=ShippingPlanForecastResponse)
def get_shipping_plan_forecast(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    sku: str = Query(min_length=1, max_length=128),
    as_of_date: date = Query(default_factory=date.today),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    result = service.get_shipping_plan_forecast(
        db, project_id=project_id, country=country, sku=sku, as_of_date=as_of_date
    )
    append_operation_view_log(db, action="shipping_plan.forecast.view", target_type="shipping_plan", target_id=project_id, operator=operator, after={"country": country, "sku": sku}, request=request)
    db.commit()
    return result


@router.put("/skus/{sku:path}/growth-factor", response_model=ShippingPlanGrowthFactorResponse)
def put_shipping_plan_growth_factor(
    sku: str,
    payload: ShippingPlanGrowthFactorUpdate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, payload.project_id, operator, bool(is_admin))
    row = service.upsert_growth_factor(
        db, project_id=payload.project_id, country=payload.country, sku=sku,
        growth_factor=payload.growth_factor, operator=operator,
    )
    append_operation_audit_log(db, action="shipping_plan.growth_factor.update", target_type="shipping_plan_sku_setting", target_id=row.id, operator=operator, after={"project_id": row.project_id, "country": row.country, "sku": row.sku, "growth_factor": str(row.growth_factor)}, request=request)
    db.commit()
    return {"project_id": row.project_id, "country": row.country, "sku": row.sku, "growth_factor": row.growth_factor, "demand_source": "manual"}


@router.get("/shipment-history", response_model=ShipmentHistoryResponse)
def get_shipping_plan_shipment_history(
    request: Request,
    etd_from: date,
    etd_to: date,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    result = service.get_shipment_history(db, project_id=project_id, country=country, etd_from=etd_from, etd_to=etd_to)
    append_operation_view_log(db, action="shipping_plan.shipment_history.view", target_type="shipping_plan", target_id=project_id, operator=operator, after={"country": country, "etd_from": str(etd_from), "etd_to": str(etd_to)}, request=request)
    db.commit()
    return result


@router.get("/batches", response_model=ShippingPlanBatchListResponse)
def get_shipping_plan_batches(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    result = service.list_plan_batches(db, project_id=project_id, country=country)
    append_operation_view_log(db, action="shipping_plan.batches.view", target_type="shipping_plan", target_id=project_id, operator=operator, after={"country": country, "count": result["total"]}, request=request)
    db.commit()
    return result


@router.post("/batches", response_model=ShippingPlanBatchResponse, status_code=201)
def post_shipping_plan_batch(
    payload: ShippingPlanBatchCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, payload.project_id, operator, bool(is_admin))
    batch = service.create_plan_batch(db, payload=payload, operator=operator)
    result = service._batch_response(db, batch)
    append_operation_audit_log(db, action="shipping_plan.batch.create", target_type="shipping_plan_batch", target_id=batch.id, operator=operator, after=result, request=request)
    db.commit()
    return result


@router.patch("/batches/{batch_id}", response_model=ShippingPlanBatchResponse)
def patch_shipping_plan_batch(
    batch_id: int,
    payload: ShippingPlanBatchUpdate,
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    batch = service.update_plan_batch(db, batch_id=batch_id, project_id=project_id, country=country, payload=payload, operator=operator)
    result = service._batch_response(db, batch)
    append_operation_audit_log(db, action="shipping_plan.batch.update", target_type="shipping_plan_batch", target_id=batch.id, operator=operator, after=result, request=request)
    db.commit()
    return result


@router.post("/batches/{batch_id}/cancel", response_model=ShippingPlanBatchResponse)
def cancel_shipping_plan_batch(
    batch_id: int,
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    batch = service.cancel_plan_batch(db, batch_id=batch_id, project_id=project_id, country=country, operator=operator)
    result = service._batch_response(db, batch)
    append_operation_audit_log(db, action="shipping_plan.batch.cancel", target_type="shipping_plan_batch", target_id=batch.id, operator=operator, after=result, request=request)
    db.commit()
    return result


@router.post("/batches/{batch_id}/allocations", response_model=ShippingPlanAllocationResult, status_code=201)
def post_shipping_plan_allocation(
    batch_id: int,
    payload: ShippingPlanAllocationCreate,
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> dict:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    plan_item = db.get(ShippingPlanItem, payload.plan_item_id)
    if plan_item is None or db.scalar(
        select(ShippingPlanBatch.id).where(
            ShippingPlanBatch.id == batch_id,
            ShippingPlanBatch.id == plan_item.batch_id,
        )
    ) is None:
        raise HTTPException(status_code=404, detail="计划 SKU 明细不存在")
    result = service.create_or_add_allocation(db, payload=payload, project_id=project_id, country=country)
    append_operation_audit_log(db, action="shipping_plan.allocation.create", target_type="shipping_plan_allocation", target_id=result["allocation"].id, operator=operator, after={"plan_item_id": payload.plan_item_id, "shipment_schedule_id": payload.shipment_schedule_id, "quantity": payload.quantity}, request=request)
    db.commit()
    return result


@router.delete("/allocations/{allocation_id}", status_code=204)
def remove_shipping_plan_allocation(
    allocation_id: int,
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> None:
    _ensure_project_access(db, project_id, operator, bool(is_admin))
    service.delete_allocation(db, allocation_id=allocation_id, project_id=project_id, country=country)
    append_operation_audit_log(db, action="shipping_plan.allocation.delete", target_type="shipping_plan_allocation", target_id=allocation_id, operator=operator, request=request)
    db.commit()

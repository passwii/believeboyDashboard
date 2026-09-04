from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.schemas.new_product_calculation import (
    NewProductCalculationCreateRequest,
    NewProductCalculationItem,
    NewProductCalculationListResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.models.new_product_calculation import NewProductCalculation
from app.services import new_product_calculation_service

router = APIRouter(
    prefix="/new-product-calculations",
    tags=["new-product-calculations"],
    dependencies=[Depends(protected)],
)


@router.get("", response_model=NewProductCalculationListResponse)
def list_new_product_calculations(
    project_id: int | None = Query(default=None),
    calculation_type: str | None = Query(default=None),
    country: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_read_db_session),
) -> NewProductCalculationListResponse:
    """获取新品核算列表（2026-08-03 由 /store-sku-pricing-snapshots 改名）"""
    rows, total = new_product_calculation_service.list_snapshots(
        db,
        project_id=project_id,
        calculation_type=calculation_type,
        country=country,
        page=page,
        page_size=page_size,
    )
    return NewProductCalculationListResponse(
        items=rows,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{project_id}/{sku}", response_model=NewProductCalculationItem)
def get_new_product_calculation(
    project_id: int,
    sku: str,
    calculation_type: str = Query(default="profit_calc"),
    db: Session = Depends(get_read_db_session),
) -> NewProductCalculationItem:
    """获取单个新品核算（2026-08-03 改名）"""
    item = new_product_calculation_service.get_snapshot(
        db,
        project_id=project_id,
        sku=sku,
        calculation_type=calculation_type,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return item


@router.post(
    "", response_model=NewProductCalculationItem, status_code=status.HTTP_201_CREATED
)
def create_or_update_new_product_calculation(
    payload: NewProductCalculationCreateRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> NewProductCalculationItem:
    """创建或更新新品核算（2026-08-03 改名）"""
    item = new_product_calculation_service.upsert_snapshot(
        db, payload, operator=operator
    )
    append_operation_audit_log(
        db,
        action="pricing_calculation.new_product_calculation.upsert",
        target_type="new_product_calculation",
        target_id=item.id,
        operator=operator,
        after={
            "id": item.id,
            "project_id": item.project_id,
            "project_name": item.project_name,
            "sku": item.sku,
            "calculation_type": item.calculation_type,
        },
        request=request,
    )
    db.commit()
    return item


@router.delete("/{snapshot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_new_product_calculation(
    snapshot_id: int,
    db: Session = Depends(get_primary_db_session),
) -> Response:
    """删除新品核算（2026-08-03 改名）"""
    deleted = new_product_calculation_service.delete_snapshot(db, snapshot_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="快照不存在")

    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

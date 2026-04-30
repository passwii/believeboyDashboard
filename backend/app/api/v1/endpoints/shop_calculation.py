from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.shop_calculation import (
    ShopCalculationCreateRequest,
    ShopCalculationItem,
    ShopCalculationListResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.models.shop_calculation import ShopCalculation
from app.services import shop_calculation_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/shop-calculation', response_model=ShopCalculationListResponse)
def list_shop_calculation(
    project_id: int | None = Query(default=None, ge=1),
    country: str | None = Query(default=None, description="按国家筛选（如 US, DE, UK）"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db_session),
) -> ShopCalculationListResponse:
    """获取店铺测算列表"""
    rows, total = shop_calculation_service.list_by_project(
        db,
        project_id=project_id,
        country=country,
        page=page,
        page_size=page_size,
    )
    return ShopCalculationListResponse(
        items=rows,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post('/shop-calculation', response_model=ShopCalculationItem, status_code=status.HTTP_201_CREATED)
def create_or_update_shop_calculation(
    payload: ShopCalculationCreateRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShopCalculationItem:
    """创建或更新店铺测算（upsert）"""
    item = shop_calculation_service.upsert(db, payload, operator=operator)
    append_operation_audit_log(
        db,
        action='pricing_calculation.shop_calculation.upsert',
        target_type='shop_calculation',
        target_id=item.id,
        operator=operator,
        after={
            'id': item.id,
            'project_id': item.project_id,
            'project_name': item.project_name,
            'sku': item.sku,
            'country': item.country,
            'accounting_type': item.accounting_type,
        },
        request=request,
    )
    db.commit()
    return item


@router.delete('/shop-calculation/{item_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_shop_calculation(
    item_id: int,
    db: Session = Depends(get_db_session),
) -> Response:
    """删除店铺测算"""
    row = db.get(ShopCalculation, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail='记录不存在')
    db.delete(row)
    db.flush()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

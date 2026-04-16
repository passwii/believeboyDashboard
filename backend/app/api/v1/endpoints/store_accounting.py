from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.store_accounting import (
    StoreAccountingCreateRequest,
    StoreAccountingItem,
    StoreAccountingListResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.models import StoreAccounting
from app.services import store_accounting_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/store-accounting', response_model=StoreAccountingListResponse)
def list_store_accounting(
    project_id: int | None = Query(default=None, ge=1),
    country: str | None = Query(default=None, description="按国家筛选（如 US, DE, UK）"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db_session),
) -> StoreAccountingListResponse:
    """获取店铺核算列表"""
    rows, total = store_accounting_service.list_by_project(
        db,
        project_id=project_id,
        country=country,
        page=page,
        page_size=page_size,
    )
    return StoreAccountingListResponse(
        items=rows,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post('/store-accounting', response_model=StoreAccountingItem, status_code=status.HTTP_201_CREATED)
def create_or_update_store_accounting(
    payload: StoreAccountingCreateRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> StoreAccountingItem:
    """创建或更新店铺核算（upsert）"""
    item = store_accounting_service.upsert(db, payload, operator=operator)
    append_operation_audit_log(
        db,
        action='pricing_calculation.store_accounting.upsert',
        target_type='store_accounting',
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


@router.delete('/store-accounting/{item_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_store_accounting(
    item_id: int,
    db: Session = Depends(get_db_session),
) -> Response:
    """删除店铺核算"""
    row = db.get(StoreAccounting, item_id)
    if row is None:
        raise HTTPException(status_code=404, detail='记录不存在')
    db.delete(row)
    db.flush()
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

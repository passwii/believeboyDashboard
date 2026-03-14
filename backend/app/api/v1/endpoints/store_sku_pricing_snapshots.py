from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.store_sku_pricing_snapshot import (
    StoreSkuPricingSnapshotCreateRequest,
    StoreSkuPricingSnapshotItem,
    StoreSkuPricingSnapshotListResponse,
)
from app.services import store_sku_pricing_snapshot_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/store-sku-pricing-snapshots', response_model=StoreSkuPricingSnapshotListResponse)
def list_store_sku_pricing_snapshots(
    project_id: int | None = Query(default=None, ge=1),
    calculation_type: str | None = Query(default=None, pattern='^(profit_calc|profit_reverse)$'),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_db_session),
) -> StoreSkuPricingSnapshotListResponse:
    """获取店铺 SKU 核算快照列表"""
    rows, total = store_sku_pricing_snapshot_service.list_snapshots(
        db,
        project_id=project_id,
        calculation_type=calculation_type,
        page=page,
        page_size=page_size,
    )
    return StoreSkuPricingSnapshotListResponse(
        items=rows,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get('/store-sku-pricing-snapshots/{project_id}/{sku}', response_model=StoreSkuPricingSnapshotItem)
def get_store_sku_pricing_snapshot(
    project_id: int,
    sku: str,
    calculation_type: str = Query(..., pattern='^(profit_calc|profit_reverse)$'),
    db: Session = Depends(get_db_session),
) -> StoreSkuPricingSnapshotItem:
    """获取单个店铺 SKU 核算快照"""
    snapshot = store_sku_pricing_snapshot_service.get_snapshot(db, project_id, sku, calculation_type)
    if not snapshot:
        raise HTTPException(status_code=404, detail='快照不存在')
    return snapshot


@router.post('/store-sku-pricing-snapshots', response_model=StoreSkuPricingSnapshotItem, status_code=status.HTTP_201_CREATED)
def create_or_update_store_sku_pricing_snapshot(
    payload: StoreSkuPricingSnapshotCreateRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> StoreSkuPricingSnapshotItem:
    """创建或更新店铺 SKU 核算快照（upsert）"""
    snapshot = store_sku_pricing_snapshot_service.upsert_snapshot(db, payload, operator=operator)
    db.commit()
    return snapshot


@router.delete('/store-sku-pricing-snapshots/{snapshot_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_store_sku_pricing_snapshot(
    snapshot_id: int,
    db: Session = Depends(get_db_session),
) -> Response:
    """删除店铺 SKU 核算快照"""
    deleted = store_sku_pricing_snapshot_service.delete_snapshot(db, snapshot_id)
    if not deleted:
        raise HTTPException(status_code=404, detail='快照不存在')

    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

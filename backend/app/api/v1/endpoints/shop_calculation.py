from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.schemas.shop_calculation import (
    ShopCalculationCreateRequest,
    ShopCalculationItem,
    ShopCalculationListResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services import shop_calculation_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/shop-calculation", response_model=ShopCalculationListResponse)
def list_shop_calculation(
    project_id: int | None = Query(default=None, ge=1),
    country: str | None = Query(
        default=None, description="按国家筛选（如 US, DE, UK）"
    ),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(get_read_db_session),
) -> ShopCalculationListResponse:
    """获取店铺测算「当前态」列表（每 SKU 最新有效行，软删过滤）"""
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


@router.get("/shop-calculation/history", response_model=list[ShopCalculationItem])
def list_shop_calculation_history(
    project_id: int = Query(ge=1),
    sku: str | None = Query(default=None, description="按 SKU 筛选"),
    country: str | None = Query(
        default=None, description="按国家筛选（如 US, DE, UK）"
    ),
    include_deleted: bool = Query(
        default=False, description="是否包含已软删行（审计用）"
    ),
    db: Session = Depends(get_read_db_session),
) -> list[ShopCalculationItem]:
    """获取店铺核算历史时间线（append-only，按 observed_at 倒序）。

    BEL-378：每次写入（手动 / Agent / 外部 API）都新增一行，本端点返回全部历史，
    供「看某 SKU 价格随时间变化」消费。
    """
    return shop_calculation_service.list_history(
        db,
        project_id=project_id,
        sku=sku,
        country=country,
        include_deleted=include_deleted,
    )


@router.post(
    "/shop-calculation",
    response_model=ShopCalculationItem,
    status_code=status.HTTP_201_CREATED,
)
def create_shop_calculation(
    payload: ShopCalculationCreateRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ShopCalculationItem:
    """新增一条店铺核算记录（append-only，带 observed_at + source）"""
    item = shop_calculation_service.append_calculation(db, payload, operator=operator)
    append_operation_audit_log(
        db,
        action="pricing_calculation.shop_calculation.append",
        target_type="shop_calculation",
        target_id=item.id,
        operator=operator,
        after={
            "id": item.id,
            "project_id": item.project_id,
            "project_name": item.project_name,
            "sku": item.sku,
            "country": item.country,
            "accounting_type": item.accounting_type,
            "source": item.source,
            "observed_at": item.observed_at.isoformat() if item.observed_at else None,
        },
        request=request,
    )
    db.commit()
    return item


@router.delete("/shop-calculation/{item_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_shop_calculation(
    item_id: int,
    db: Session = Depends(get_primary_db_session),
) -> Response:
    """软删除店铺核算（按 SKU 组：移除该 SKU 全部有效行，历史保留可恢复）"""
    deleted = shop_calculation_service.soft_delete_group(db, item_id)
    if deleted == 0:
        raise HTTPException(status_code=404, detail="记录不存在")
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

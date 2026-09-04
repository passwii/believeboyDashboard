"""Pricing calculation snapshot endpoints.

提供店铺定价历史快照的 CRUD。
- 创建：从 ``shop_calculation`` 复制当前态到 ``pricing_calculation_snapshot_items``
  （2026-08-03 注：历史曾从已弃用的 ``store_sku_pricing_snapshots``/现 ``new_product_calculations`` 复制，
   Phase A 后改为读 ``shop_calculation``，因为店铺测算页面才是"测算"按钮的实际写入目标）
- 列表 / 详情 / 明细：只读
- 更新 / 删除：仅 admin（与 ``inventory_replenishment_snapshots`` 一致）

路由前缀：``/api/v1/pricing-calculation-snapshots``
"""

from __future__ import annotations

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.schemas.pricing_calculation_snapshot import (
    CreatePricingCalculationSnapshotRequest,
    PricingCalculationSnapshotDetail,
    PricingCalculationSnapshotItemsResponse,
    PricingCalculationSnapshotListItem,
    UpdatePricingCalculationSnapshotRequest,
)
from app.services import pricing_calculation_snapshot_service as _svc
from app.services import project_service
from app.services.audit_log_service import append_operation_audit_log


router = APIRouter(
    prefix="/pricing-calculation-snapshots", dependencies=[Depends(protected)]
)


# ── Create ──────────────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=PricingCalculationSnapshotDetail,
    status_code=status.HTTP_201_CREATED,
)
def create_pricing_calculation_snapshot(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US", min_length=1, max_length=8),
    payload: CreatePricingCalculationSnapshotRequest | None = None,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> PricingCalculationSnapshotDetail:
    """创建定价历史快照

    从 ``shop_calculation`` 读取 ``(project_id, country)`` 当前态，
    复制为新的快照（append-only）。原表不受影响。
    （2026-08-03 注：历史读源是已弃用的 ``store_sku_pricing_snapshots``/现 ``new_product_calculations``，
     Phase A 后改为 ``shop_calculation``。）
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    name = payload.name if payload else None
    description = payload.description if payload else None

    snapshot = _svc.create_snapshot(
        db,
        project_id=project_id,
        country=country,
        name=name,
        description=description,
        operator=operator,
    )

    append_operation_audit_log(
        db,
        action="pricing_calculation_snapshot.create",
        target_type="pricing_calculation_snapshot",
        target_id=snapshot.id,
        operator=operator,
        after={
            "id": snapshot.id,
            "project_id": snapshot.project_id,
            "country": snapshot.country,
            "name": snapshot.name,
            "row_count": snapshot.row_count,
        },
        request=request,
    )
    db.commit()

    detail = _svc.get_snapshot_detail(db, snapshot.id)
    assert detail is not None  # 我们刚创建，不可能为 None
    return detail


# ── List ─────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[PricingCalculationSnapshotListItem])
def list_pricing_calculation_snapshots(
    project_id: int = Query(gt=0),
    country: str = Query(default="US", min_length=1, max_length=8),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_read_db_session),
) -> list[PricingCalculationSnapshotListItem]:
    """按 (project, country) 列出历史快照"""
    return _svc.list_snapshots(
        db,
        project_id=project_id,
        country=country,
        page=page,
        page_size=page_size,
    )


# ── Detail ──────────────────────────────────────────────────────────────────


@router.get("/{snapshot_id}", response_model=PricingCalculationSnapshotDetail)
def get_pricing_calculation_snapshot_detail(
    snapshot_id: int,
    db: Session = Depends(get_read_db_session),
) -> PricingCalculationSnapshotDetail:
    detail = _svc.get_snapshot_detail(db, snapshot_id)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")
    return detail


# ── Items (前端回放用，items 形状与 ShopCalculationItem 一致) ─────────────────


@router.get(
    "/{snapshot_id}/items", response_model=PricingCalculationSnapshotItemsResponse
)
def get_pricing_calculation_snapshot_items(
    snapshot_id: int,
    db: Session = Depends(get_read_db_session),
) -> PricingCalculationSnapshotItemsResponse:
    response = _svc.get_snapshot_items(db, snapshot_id)
    if response is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")
    return response


# ── Update (admin only) ─────────────────────────────────────────────────────


@router.patch("/{snapshot_id}", response_model=PricingCalculationSnapshotListItem)
def update_pricing_calculation_snapshot(
    request: Request,
    snapshot_id: int,
    payload: UpdatePricingCalculationSnapshotRequest,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> PricingCalculationSnapshotListItem:
    """更新快照名称或备注（仅管理员）"""
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可修改快照",
        )

    updated = _svc.update_snapshot(
        db,
        snapshot_id=snapshot_id,
        name=payload.name,
        description=payload.description,
        operator=operator,
    )

    append_operation_audit_log(
        db,
        action="pricing_calculation_snapshot.update",
        target_type="pricing_calculation_snapshot",
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
    return updated


# ── Delete (admin only) ─────────────────────────────────────────────────────


@router.delete(
    "/{snapshot_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response
)
def delete_pricing_calculation_snapshot(
    request: Request,
    snapshot_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
) -> Response:
    """删除快照（级联删除 items，仅管理员）"""
    if not is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="仅管理员可删除快照",
        )

    # 先取 header 拿 project_id 写审计日志
    detail = _svc.get_snapshot_detail(db, snapshot_id)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    success = _svc.delete_snapshot(db, snapshot_id)
    if not success:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="快照不存在")

    append_operation_audit_log(
        db,
        action="pricing_calculation_snapshot.delete",
        target_type="pricing_calculation_snapshot",
        target_id=snapshot_id,
        operator=operator,
        after={"snapshot_id": snapshot_id, "project_id": detail.project_id},
        request=request,
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.pricing_calculation import (
    PricingCalculationCostReverseRequest,
    PricingCalculationCreateRequest,
    PricingCalculationReverseRequest,
    PricingCalculationRunItem,
    PricingCalculationRunListResponse,
)
from app.services import pricing_calculation_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/pricing-calculation/runs', response_model=PricingCalculationRunListResponse)
def list_pricing_runs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=12, ge=1, le=100),
    exclude_project_id: bool = Query(default=True, description="是否排除店铺核算记录（只返回新品核算）"),
    db: Session = Depends(get_db_session),
) -> PricingCalculationRunListResponse:
    rows, total = pricing_calculation_service.list_pricing_runs(db, page=page, page_size=page_size, exclude_project_id=exclude_project_id)
    return PricingCalculationRunListResponse(
        items=[PricingCalculationRunItem(**pricing_calculation_service.serialize_pricing_run(row)) for row in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post('/pricing-calculation/quote', response_model=PricingCalculationRunItem)
def calculate_pricing_quote(
    payload: PricingCalculationCreateRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = pricing_calculation_service.create_pricing_run(db, payload, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    db.commit()
    return PricingCalculationRunItem(**pricing_calculation_service.serialize_pricing_run(row))


@router.post('/pricing-calculation/reverse-quote', response_model=PricingCalculationRunItem)
def calculate_pricing_reverse_quote(
    payload: PricingCalculationReverseRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = pricing_calculation_service.create_pricing_reverse_run(db, payload, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    db.commit()
    return PricingCalculationRunItem(**pricing_calculation_service.serialize_pricing_run(row))


@router.post('/pricing-calculation/reverse-cost', response_model=PricingCalculationRunItem)
def calculate_pricing_reverse_cost(
    payload: PricingCalculationCostReverseRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = pricing_calculation_service.create_pricing_cost_reverse_run(db, payload, operator=operator)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    db.commit()
    return PricingCalculationRunItem(**pricing_calculation_service.serialize_pricing_run(row))


@router.delete('/pricing-calculation/runs/{run_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_pricing_run(
    run_id: int,
    db: Session = Depends(get_db_session),
) -> Response:
    deleted = pricing_calculation_service.delete_pricing_run(db, run_id)
    if not deleted:
        raise HTTPException(status_code=404, detail='测算记录不存在')

    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post('/pricing-calculation/runs/{run_id}/recalculate', response_model=PricingCalculationRunItem)
def recalculate_pricing_run(
    run_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    """重新计算已有的测算记录，使用最新的计算逻辑（回款=售价-费用合计含广告费）"""
    # 获取原有记录
    row = db.get(pricing_calculation_service.PricingCalculationRun, run_id)
    if not row:
        raise HTTPException(status_code=404, detail='测算记录不存在')

    # 构建计算请求参数
    from app.schemas.pricing_calculation import PricingCalculationCreateRequest
    
    payload = PricingCalculationCreateRequest(
        product_name=row.product_name,
        package_length_cm=float(row.package_length_cm),
        package_width_cm=float(row.package_width_cm),
        package_height_cm=float(row.package_height_cm),
        weight_kg=float(row.weight_kg),
        fob_product_cost_rmb=float(row.fob_product_cost_rmb),
        first_leg_cost_rmb=float(row.first_leg_cost_rmb),
        sale_price_usd=float(row.sale_price_usd),
        advertising_rate=float(row.advertising_rate),
        return_loss_rate=float(row.return_loss_rate),
        storage_months=float(row.storage_months),
        inbound_placement_mode=row.inbound_placement_mode,
        usd_to_rmb_rate=float(row.usd_to_rmb_rate),
    )
    
    # 重新计算
    computed = pricing_calculation_service._compute_pricing(payload, db)
    
    # 更新原有记录
    row.payout_usd = computed['profit_decimal']['payout_usd']
    row.profit_usd = computed['profit_decimal']['profit_usd']
    row.profit_rate = computed['profit_decimal']['profit_rate']
    row.total_fee_usd = computed['fees_decimal']['total_fee_usd']
    
    db.commit()
    db.refresh(row)
    
    return PricingCalculationRunItem(**pricing_calculation_service.serialize_pricing_run(row))

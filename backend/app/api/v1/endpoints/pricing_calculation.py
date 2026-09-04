from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_operator,
    protected,
)
from app.schemas.pricing_calculation import (
    PricingCalculationCostReverseRequest,
    PricingCalculationCreateRequest,
    PricingCalculationEURequest,
    PricingCalculationFbmRequest,
    PricingCalculationReverseRequest,
    PricingCalculationRunItem,
    PricingCalculationRunListResponse,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services.pricing import (
    PricingCalculationRun,
    can_access_pricing_run,
    create_pricing_cost_reverse_run,
    create_pricing_eu_run,
    create_pricing_fbm_run,
    create_pricing_reverse_run,
    create_pricing_run,
    delete_pricing_run,
    list_pricing_runs,
    serialize_pricing_run,
)
from app.services.pricing.computation import _compute_pricing

router = APIRouter(dependencies=[Depends(protected)])


@router.get(
    "/pricing-calculation/runs", response_model=PricingCalculationRunListResponse
)
def list_pricing_runs_endpoint(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=12, ge=1, le=100),
    exclude_project_id: bool = Query(
        default=True, description="是否排除店铺核算记录（只返回新品核算）"
    ),
    country: str | None = Query(default=None, description="按国家筛选（如 US, DE, UK）"),
    keyword: str | None = Query(
        default=None,
        max_length=100,
        description="按产品名/创建人模糊搜索（大小写不敏感，命中 product_name 或 created_by）",
    ),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> PricingCalculationRunListResponse:
    rows, total = list_pricing_runs(
        db,
        page=page,
        page_size=page_size,
        exclude_project_id=exclude_project_id,
        country=country,
        keyword=keyword,
        operator=operator,
        is_admin=is_admin,
    )
    return PricingCalculationRunListResponse(
        items=[
            PricingCalculationRunItem(
                **serialize_pricing_run(row)
            )
            for row in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/pricing-calculation/quote", response_model=PricingCalculationRunItem)
def calculate_pricing_quote(
    payload: PricingCalculationCreateRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = create_pricing_run(
            db, payload, operator=operator
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    serialized = serialize_pricing_run(row)
    append_operation_audit_log(
        db,
        action="pricing_calculation.run.create",
        target_type="pricing_calculation_run",
        target_id=row.id,
        operator=operator,
        after=serialized,
        request=request,
    )
    db.commit()
    return PricingCalculationRunItem(**serialized)


@router.post(
    "/pricing-calculation/reverse-quote", response_model=PricingCalculationRunItem
)
def calculate_pricing_reverse_quote(
    payload: PricingCalculationReverseRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = create_pricing_reverse_run(
            db, payload, operator=operator
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    serialized = serialize_pricing_run(row)
    append_operation_audit_log(
        db,
        action="pricing_calculation.run.create",
        target_type="pricing_calculation_run",
        target_id=row.id,
        operator=operator,
        after=serialized,
        request=request,
    )
    db.commit()
    return PricingCalculationRunItem(**serialized)


@router.post(
    "/pricing-calculation/reverse-cost", response_model=PricingCalculationRunItem
)
def calculate_pricing_reverse_cost(
    payload: PricingCalculationCostReverseRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = create_pricing_cost_reverse_run(
            db, payload, operator=operator
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    serialized = serialize_pricing_run(row)
    append_operation_audit_log(
        db,
        action="pricing_calculation.run.create",
        target_type="pricing_calculation_run",
        target_id=row.id,
        operator=operator,
        after=serialized,
        request=request,
    )
    db.commit()
    return PricingCalculationRunItem(**serialized)


@router.post("/pricing-calculation/fbm-quote", response_model=PricingCalculationRunItem)
def calculate_pricing_fbm_quote(
    payload: PricingCalculationFbmRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    try:
        row = create_pricing_fbm_run(
            db, payload, operator=operator
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    serialized = serialize_pricing_run(row)
    append_operation_audit_log(
        db,
        action="pricing_calculation.run.create",
        target_type="pricing_calculation_run",
        target_id=row.id,
        operator=operator,
        after=serialized,
        request=request,
    )
    db.commit()
    return PricingCalculationRunItem(**serialized)


@router.post("/pricing-calculation/eu-quote", response_model=PricingCalculationRunItem)
def calculate_pricing_eu_quote(
    payload: PricingCalculationEURequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> PricingCalculationRunItem:
    """欧洲（德国/英国）店铺 SKU 核算，使用手动费用和 VAT 计算"""
    try:
        row = create_pricing_eu_run(
            db, payload, operator=operator
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    serialized = serialize_pricing_run(row)
    append_operation_audit_log(
        db,
        action="pricing_calculation.run.create_eu",
        target_type="pricing_calculation_run",
        target_id=row.id,
        operator=operator,
        after=serialized,
        request=request,
    )
    db.commit()
    return PricingCalculationRunItem(**serialized)


@router.delete(
    "/pricing-calculation/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_pricing_run_endpoint(
    run_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> Response:
    row = db.get(PricingCalculationRun, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="测算记录不存在")
    if not can_access_pricing_run(
        row, operator=operator, is_admin=is_admin
    ):
        raise HTTPException(status_code=403, detail="无权操作该测算记录")

    before = serialize_pricing_run(row)
    deleted = delete_pricing_run(
        db, run_id, operator=operator, is_admin=is_admin
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="测算记录不存在")

    append_operation_audit_log(
        db,
        action="pricing_calculation.run.delete",
        target_type="pricing_calculation_run",
        target_id=run_id,
        operator=operator,
        before=before,
        request=request,
    )
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/pricing-calculation/runs/{run_id}/recalculate",
    response_model=PricingCalculationRunItem,
)
def recalculate_pricing_run(
    run_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> PricingCalculationRunItem:
    """重新计算已有的测算记录，使用最新的计算逻辑（回款=售价-费用合计含广告费）"""
    # 获取原有记录
    row = db.get(PricingCalculationRun, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="测算记录不存在")
    if not can_access_pricing_run(
        row, operator=operator, is_admin=is_admin
    ):
        raise HTTPException(status_code=403, detail="无权操作该测算记录")

    before = serialize_pricing_run(row)

    # 构建计算请求参数
    from app.schemas.pricing_calculation import PricingCalculationCreateRequest

    payload = PricingCalculationCreateRequest(
        country=getattr(row, "country", "US") or "US",
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
    computed = _compute_pricing(payload, db)

    # 更新原有记录
    row.payout_usd = computed["profit_decimal"]["payout_usd"]
    row.profit_usd = computed["profit_decimal"]["profit_usd"]
    row.profit_rate = computed["profit_decimal"]["profit_rate"]
    row.total_fee_usd = computed["fees_decimal"]["total_fee_usd"]
    row.vat_usd = computed["profit_decimal"].get("vat_usd", row.vat_usd)
    row.profit_after_vat_usd = computed["profit_decimal"].get("profit_after_vat_usd")
    row.profit_after_vat_rate = computed["profit_decimal"].get("profit_after_vat_rate")

    db.refresh(row)
    serialized = serialize_pricing_run(row)
    append_operation_audit_log(
        db,
        action="pricing_calculation.run.recalculate",
        target_type="pricing_calculation_run",
        target_id=run_id,
        operator=operator,
        before=before,
        after=serialized,
        request=request,
    )
    db.commit()

    return PricingCalculationRunItem(**serialized)

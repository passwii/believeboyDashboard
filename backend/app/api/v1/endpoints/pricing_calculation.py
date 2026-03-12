from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.pricing_calculation import (
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
    db: Session = Depends(get_db_session),
) -> PricingCalculationRunListResponse:
    rows, total = pricing_calculation_service.list_pricing_runs(db, page=page, page_size=page_size)
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

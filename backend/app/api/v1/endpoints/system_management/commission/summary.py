"""
佣金汇总端点。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)

from app.schemas.system_management.commission.summary import (
    CommissionYearlyMonthlySummaryItem,
    CommissionYearlyMonthlySummaryResponse,
    CommissionProjectYearlySummaryItem,
    CommissionProjectYearlySummaryResponse,
    RecomputeCommissionRequest,
    RecomputeCommissionResponse,
)

from app.services.audit_log_service import (
    append_operation_view_log,
    append_operation_audit_log,
)
from app.services.system_management import (
    _parse_report_month,
    _parse_year,
    _to_iso,
    get_commission_yearly_monthly_summary,
    get_commission_project_yearly_summary,
    recompute_commission_records,
)
from app.services.infra.cache_decorator import invalidate_cache_on_commit
from app.services.infra.commission_cache import (
    get_commission_summary_cache,
    set_commission_summary_cache,
)


router = APIRouter(prefix="/commission-management", tags=["佣金管理"])


@router.get("/summary/monthly", response_model=CommissionYearlyMonthlySummaryResponse)
def list_commission_yearly_monthly_summary(
    year: str,
    request: Request,
    country: str | None = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionYearlyMonthlySummaryResponse:
    try:
        normalized_year = _parse_year(year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    cached = get_commission_summary_cache("monthly", normalized_year, country)
    if cached is not None:
        return CommissionYearlyMonthlySummaryResponse(**cached)

    items_data = get_commission_yearly_monthly_summary(
        db, year=normalized_year, country=country
    )
    items = [CommissionYearlyMonthlySummaryItem(**item) for item in items_data]

    append_operation_view_log(
        db,
        action="commission.summary.monthly.view",
        target_type="commission_summary",
        target_id=normalized_year,
        operator=operator,
        after={"year": normalized_year, "country": country, "count": len(items)},
        request=request,
    )
    db.commit()

    payload = {
        "year": normalized_year,
        "items": [i.model_dump(mode="json") for i in items],
    }
    set_commission_summary_cache("monthly", normalized_year, country, payload)
    return CommissionYearlyMonthlySummaryResponse(**payload)


@router.get("/summary/project", response_model=CommissionProjectYearlySummaryResponse)
def list_commission_project_yearly_summary(
    year: str,
    request: Request,
    country: str | None = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionProjectYearlySummaryResponse:
    try:
        normalized_year = _parse_year(year)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    cached = get_commission_summary_cache("project", normalized_year, country)
    if cached is not None:
        return CommissionProjectYearlySummaryResponse(**cached)

    items_data = get_commission_project_yearly_summary(
        db, year=normalized_year, country=country
    )
    items = [CommissionProjectYearlySummaryItem(**item) for item in items_data]

    append_operation_view_log(
        db,
        action="commission.summary.project.view",
        target_type="commission_summary",
        target_id=normalized_year,
        operator=operator,
        after={"year": normalized_year, "country": country, "count": len(items)},
        request=request,
    )
    db.commit()

    payload = {
        "year": normalized_year,
        "items": [i.model_dump(mode="json") for i in items],
    }
    set_commission_summary_cache("project", normalized_year, country, payload)
    return CommissionProjectYearlySummaryResponse(**payload)


@router.post("/recompute", response_model=RecomputeCommissionResponse)
@invalidate_cache_on_commit(
    domains=["commission_records"],
    cascade=[
        "commission_summary",
        "commission_ratio_overrides",
        "operator_performance",
        "data_management",
    ],
    project_id_from="global",
)
def recompute_commission_records_endpoint(
    payload: RecomputeCommissionRequest,
    request: Request,
    country: str | None = None,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> RecomputeCommissionResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    now = datetime.now().astimezone().replace(microsecond=0)

    try:
        project_month_count, record_count, locked_record_count = (
            recompute_commission_records(
                db,
                report_month=report_month,
                now=now,
                country=country,
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    append_operation_audit_log(
        db,
        action="commission.bonus.recompute",
        target_type="commission_bonus_record",
        target_id=report_month,
        operator=operator,
        after={
            "report_month": report_month,
            "country": country,
            "project_month_count": project_month_count,
            "record_count": record_count,
        },
        request=request,
    )

    return RecomputeCommissionResponse(
        report_month=report_month,
        project_month_count=project_month_count,
        record_count=record_count,
        locked_record_count=locked_record_count,
        computed_at=_to_iso(now) or "",
    )

"""
佣金比例覆盖端点。
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_operator,
    protected,
)
from app.models.commission_ratio_override import CommissionRatioOverride

from app.schemas.system_management.commission.ratio_overrides import (
    CommissionRatioOverrideItem,
    CommissionRatioOverridesResponse,
    UpsertCommissionRatioOverridesRequest,
)

from app.schemas.system_management.commission._enums import CommissionIncomeCategory

from app.services.audit_log_service import (
    append_operation_view_log,
    append_operation_audit_log,
)
from app.services.system_management import (
    _parse_report_month,
    _to_iso,
    upsert_commission_ratio_overrides,
)
from app.services.infra.cache_decorator import invalidate_cache_on_commit
from app.services.infra.commission_cache import (
    get_commission_ratio_overrides_cache,
    set_commission_ratio_overrides_cache,
)


router = APIRouter(prefix="/commission-management", tags=["佣金管理"])


def _serialize_ratio_override_row(
    row: CommissionRatioOverride,
) -> CommissionRatioOverrideItem:
    return CommissionRatioOverrideItem(
        id=row.id,
        report_month=row.report_month,
        project_id=row.project_id,
        project_name=row.project_name,
        person_name=row.person_name,
        income_category=CommissionIncomeCategory(row.income_category),
        override_ratio=float(row.override_ratio),
        reason=row.reason,
        updated_by=row.updated_by,
        updated_at=_to_iso(row.updated_at) or "",
    )


@router.post("/ratio-overrides/upsert", response_model=CommissionRatioOverridesResponse)
@invalidate_cache_on_commit(
    domains=["commission_ratio_overrides"],
    cascade=["commission_summary", "operator_performance", "data_management"],
    project_id_from="global",
)
def upsert_commission_ratio_overrides_endpoint(
    payload: UpsertCommissionRatioOverridesRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRatioOverridesResponse:
    try:
        report_month = _parse_report_month(payload.report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rows = upsert_commission_ratio_overrides(
        db,
        report_month=report_month,
        items=payload.items,
        updated_by=operator,
    )

    append_operation_audit_log(
        db,
        action="commission.ratio_overrides.upsert",
        target_type="commission_ratio_override",
        target_id=report_month,
        operator=operator,
        after={"report_month": report_month, "incoming_items": len(payload.items)},
        request=request,
    )

    return CommissionRatioOverridesResponse(
        report_month=report_month,
        items=[_serialize_ratio_override_row(r) for r in rows],
    )


@router.get("/ratio-overrides", response_model=CommissionRatioOverridesResponse)
def list_commission_ratio_overrides(
    report_month: str,
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
) -> CommissionRatioOverridesResponse:
    try:
        month = _parse_report_month(report_month)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    cached = get_commission_ratio_overrides_cache(report_month=month)
    if cached is not None:
        return CommissionRatioOverridesResponse(**cached)

    rows = (
        db.execute(
            select(CommissionRatioOverride)
            .where(CommissionRatioOverride.report_month == month)
            .order_by(
                CommissionRatioOverride.person_name.asc(),
                CommissionRatioOverride.project_name.asc(),
                CommissionRatioOverride.income_category.asc(),
            )
        )
        .scalars()
        .all()
    )

    append_operation_view_log(
        db,
        action="commission.ratio_overrides.view",
        target_type="commission_ratio_override",
        target_id=month,
        operator=operator,
        after={"report_month": month, "count": len(rows)},
        request=request,
    )
    db.commit()
    payload = {
        "report_month": month,
        "items": [
            _serialize_ratio_override_row(r).model_dump(mode="json") for r in rows
        ],
    }
    set_commission_ratio_overrides_cache(report_month=month, data=payload)
    return CommissionRatioOverridesResponse(**payload)

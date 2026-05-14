"""
运营绩效端点。
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.models.operator_performance_record import OperatorPerformanceRecord

from app.schemas.system_management.operator_performance import (
    OperatorPerformanceItem,
    OperatorPerformanceResponse,
    UpsertOperatorPerformanceRequest,
)

from app.services.audit_log_service import append_operation_view_log, append_operation_audit_log
from app.services.system_management import (
    _parse_report_month,
    _to_iso,
    upsert_operator_performance,
)
from app.services.infra import invalidate_data_management_overview_cache


router = APIRouter(prefix="/operator-management", tags=["运营绩效"])


def _serialize_operator_performance_row(row: OperatorPerformanceRecord) -> OperatorPerformanceItem:
    return OperatorPerformanceItem(
        id=row.id, report_month=row.report_month, week_index=row.week_index,
        project_id=row.project_id, project_name=row.project_name, person_name=row.person_name,
        role_type=row.role_type, score=int(row.score), note=row.note,
        updated_by=row.updated_by, updated_at=_to_iso(row.updated_at) or "",
    )


@router.get("/performance", response_model=OperatorPerformanceResponse)
def list_operator_performance(
    report_month: str,
    request: Request,
    project_id: int | None = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> OperatorPerformanceResponse:
    month = _parse_report_month(report_month)
    stmt = select(OperatorPerformanceRecord).where(OperatorPerformanceRecord.report_month == month)
    if project_id is not None and project_id > 0:
        stmt = stmt.where(OperatorPerformanceRecord.project_id == project_id)
    stmt = stmt.order_by(
        OperatorPerformanceRecord.person_name.asc(),
        OperatorPerformanceRecord.project_name.asc(),
        OperatorPerformanceRecord.week_index.asc()
    )
    rows = db.execute(stmt).scalars().all()
    append_operation_view_log(db, action="operator.performance.view", target_type="operator_performance_record", target_id=month, operator=operator, after={"report_month": month, "project_id": project_id, "count": len(rows)}, request=request)
    db.commit()
    return OperatorPerformanceResponse(report_month=month, items=[_serialize_operator_performance_row(r) for r in rows])


@router.post("/performance/upsert", response_model=OperatorPerformanceResponse)
def upsert_operator_performance_endpoint(
    payload: UpsertOperatorPerformanceRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> OperatorPerformanceResponse:
    # 验证输入
    for item in payload.items:
        month = _parse_report_month(item.report_month)
        person_name = item.person_name.strip()
        role_type = item.role_type.strip()
        project_name = item.project_name.strip()
        if not person_name:
            raise HTTPException(status_code=422, detail="person_name is required")
        if not role_type:
            raise HTTPException(status_code=422, detail="role_type is required")
        if not project_name:
            raise HTTPException(status_code=422, detail="project_name is required")

    target_month, rows = upsert_operator_performance(
        db,
        items=payload.items,
        operator=operator,
    )

    append_operation_audit_log(db, action="operator.performance.upsert", target_type="operator_performance_record", operator=operator, after={"incoming_items": len(payload.items)}, request=request)
    invalidate_data_management_overview_cache()

    if not target_month:
        return OperatorPerformanceResponse(report_month="", items=[])

    return OperatorPerformanceResponse(report_month=target_month, items=[_serialize_operator_performance_row(r) for r in rows])
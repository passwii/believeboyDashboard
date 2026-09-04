"""
项目角色分配端点。
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
from app.models.project_role_assignment import ProjectRoleAssignment

from app.schemas.system_management.commission.role_assignments import (
    ProjectRoleAssignmentItem,
    ProjectRoleAssignmentsResponse,
    UpsertProjectRoleAssignmentsRequest,
)

from app.services.audit_log_service import (
    append_operation_view_log,
    append_operation_audit_log,
)
from app.services.system_management import (
    _parse_report_month,
    _to_iso,
    upsert_project_role_assignments,
)
from app.services.infra.cache_decorator import invalidate_cache_on_commit
from app.services.infra.commission_cache import (
    get_commission_role_assignments_cache,
    set_commission_role_assignments_cache,
)


router = APIRouter(prefix="/commission-management", tags=["佣金管理"])


def _serialize_role_assignment_row(
    row: ProjectRoleAssignment,
) -> ProjectRoleAssignmentItem:
    return ProjectRoleAssignmentItem(
        id=row.id,
        project_id=row.project_id,
        role_type=row.role_type,
        person_name=row.person_name,
        effective_from_month=row.effective_from_month,
        effective_to_month=row.effective_to_month,
        updated_at=_to_iso(row.updated_at) or "",
    )


@router.get("/role-assignments", response_model=ProjectRoleAssignmentsResponse)
def list_project_role_assignments(
    request: Request,
    report_month: str | None = None,
    project_id: int | None = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProjectRoleAssignmentsResponse:
    month_for_cache = None
    if report_month:
        month_for_cache = _parse_report_month(report_month)
    cached = get_commission_role_assignments_cache(
        project_id=project_id, report_month=month_for_cache
    )
    if cached is not None:
        return ProjectRoleAssignmentsResponse(**cached)

    stmt = select(ProjectRoleAssignment)
    if project_id is not None and project_id > 0:
        stmt = stmt.where(ProjectRoleAssignment.project_id == project_id)
    if report_month:
        month = _parse_report_month(report_month)
        stmt = stmt.where(
            ProjectRoleAssignment.effective_from_month <= month,
            (ProjectRoleAssignment.effective_to_month.is_(None))
            | (ProjectRoleAssignment.effective_to_month >= month),
        )
    stmt = stmt.order_by(
        ProjectRoleAssignment.project_id.asc(),
        ProjectRoleAssignment.role_type.asc(),
        ProjectRoleAssignment.effective_from_month.asc(),
        ProjectRoleAssignment.person_name.asc(),
    )
    rows = db.execute(stmt).scalars().all()
    append_operation_view_log(
        db,
        action="commission.role_assignments.view",
        target_type="project_role_assignment",
        target_id=project_id,
        operator=operator,
        after={
            "report_month": report_month,
            "project_id": project_id,
            "count": len(rows),
        },
        request=request,
    )
    db.commit()
    payload = {
        "items": [
            _serialize_role_assignment_row(r).model_dump(mode="json") for r in rows
        ]
    }
    set_commission_role_assignments_cache(
        project_id=project_id, report_month=month_for_cache, data=payload
    )
    return ProjectRoleAssignmentsResponse(**payload)


@router.post("/role-assignments/upsert", response_model=ProjectRoleAssignmentsResponse)
@invalidate_cache_on_commit(
    domains=["commission_role_assignments"],
    cascade=["commission_summary", "operator_performance", "data_management"],
    project_id_from="global",
)
def upsert_project_role_assignments_endpoint(
    payload: UpsertProjectRoleAssignmentsRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
) -> ProjectRoleAssignmentsResponse:
    # 验证输入
    for item in payload.items:
        from_month = _parse_report_month(item.effective_from_month)
        to_month = (
            _parse_report_month(item.effective_to_month)
            if item.effective_to_month
            else None
        )
        role_type = item.role_type.strip()
        person_name = item.person_name.strip()
        if to_month is not None and to_month < from_month:
            raise HTTPException(
                status_code=422,
                detail="effective_to_month must be >= effective_from_month",
            )
        if not role_type:
            raise HTTPException(status_code=422, detail="role_type is required")
        if not person_name:
            raise HTTPException(status_code=422, detail="person_name is required")

    rows = upsert_project_role_assignments(db, items=payload.items)

    append_operation_audit_log(
        db,
        action="commission.role_assignments.upsert",
        target_type="project_role_assignment",
        operator=operator,
        after={"incoming_items": len(payload.items)},
        request=request,
    )

    return ProjectRoleAssignmentsResponse(
        items=[_serialize_role_assignment_row(r) for r in rows]
    )

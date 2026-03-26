from fastapi import APIRouter, Depends, Header, Request
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.project import ProjectCreate, ProjectItem, ProjectOption, ProjectUpdate
from app.services.audit_log_service import append_operation_audit_log, append_operation_view_log
from app.services import project_service

router = APIRouter(dependencies=[Depends(protected)])


def _serialize_project_item(row) -> dict[str, object | None]:
    return {
        'id': row.id,
        'name': row.project_name,
        'brand_name': row.brand_name,
        'store_address': row.store_address,
        'project_operator': row.project_operator,
        'assistant_operator': row.assistant_operator,
        'commission_basis': row.commission_basis,
        'commission_rate': float(row.commission_rate) if row.commission_rate is not None else None,
        'sort_order': row.sort_order,
        'source_file': row.source_file,
    }


@router.get('/projects')
def list_projects(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> list[ProjectOption]:
    payload = project_service.list_project_options(db)
    append_operation_view_log(
        db,
        action='projects.options.view',
        target_type='project',
        operator=operator,
        after={'count': len(payload)},
        request=request,
    )
    db.commit()
    return [ProjectOption(**item) for item in payload]


@router.get('/projects/operator-options')
def list_project_operator_options(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> list[str]:
    payload = project_service.list_project_operator_options(db)
    append_operation_view_log(
        db,
        action='projects.operator_options.view',
        target_type='project_operator',
        operator=operator,
        after={'count': len(payload)},
        request=request,
    )
    db.commit()
    return payload


@router.get('/projects/manage')
def list_projects_manage(
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> list[ProjectItem]:
    rows = project_service.list_project_items(
        db,
        operator=operator,
        is_admin=bool(is_admin),
    )
    append_operation_view_log(
        db,
        action='projects.list',
        target_type='project',
        operator=operator,
        after={'count': len(rows)},
        request=request,
    )
    db.commit()

    return [
        ProjectItem(
            id=row.id,
            name=row.project_name,
            brand_name=row.brand_name,
            store_address=row.store_address,
            project_operator=row.project_operator,
            assistant_operator=row.assistant_operator,
            commission_basis=row.commission_basis,
            commission_rate=float(row.commission_rate) if row.commission_rate is not None else None,
            sort_order=row.sort_order,
            source_file=row.source_file,
        )
        for row in rows
    ]


@router.post('/projects', response_model=ProjectItem)
def create_project(
    payload: ProjectCreate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectItem:
    project_service.ensure_project_creation_allowed(
        operator,
        is_admin=bool(is_admin),
        project_operator=payload.project_operator,
        assistant_operator=payload.assistant_operator,
    )
    row = project_service.create_single_project(
        db,
        payload.name,
        payload.brand_name,
        payload.store_address,
        payload.project_operator,
        payload.assistant_operator,
        payload.commission_basis,
        payload.commission_rate,
    )
    after = _serialize_project_item(row)
    append_operation_audit_log(
        db,
        action='projects.create',
        target_type='project',
        target_id=row.id,
        operator=operator,
        after=after,
        request=request,
    )
    db.commit()
    return ProjectItem(**after)


@router.patch('/projects/{project_id}', response_model=ProjectItem)
def update_project(
    project_id: int,
    payload: ProjectUpdate,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectItem:
    before_row = project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    before = _serialize_project_item(before_row)

    row = project_service.update_project(
        db,
        project_id,
        payload.name,
        payload.brand_name,
        payload.store_address,
        payload.project_operator,
        payload.assistant_operator,
        payload.commission_basis,
        payload.commission_rate,
    )
    after = _serialize_project_item(row)
    append_operation_audit_log(
        db,
        action='projects.update',
        target_type='project',
        target_id=project_id,
        operator=operator,
        before=before,
        after=after,
        request=request,
    )
    db.commit()
    return ProjectItem(**after)

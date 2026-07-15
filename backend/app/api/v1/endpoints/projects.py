from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.api.deps import get_primary_db_session, get_read_db_session, get_request_operator, protected
from app.models import Project
from app.schemas.project import ProjectContextResponse, ProjectContextUpdate, ProjectCreate, ProjectItem, ProjectOption, ProjectUpdate, ParseContextRequest, ParseContextResponse
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
        'is_active': row.is_active,
        'source_file': row.source_file,
        'has_context': bool(row.project_context or row.sku_context),
        'project_tier': row.project_tier,
        'vat_enabled': row.vat_enabled,
    }


@router.get('/projects')
def list_projects(
    request: Request,
    db: Session = Depends(get_read_db_session),
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
    db: Session = Depends(get_read_db_session),
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
    show_inactive: bool = Query(default=False),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> list[ProjectItem]:
    rows = project_service.list_project_items(
        db,
        operator=operator,
        is_admin=bool(is_admin),
        include_inactive=show_inactive,
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
            is_active=row.is_active,
            source_file=row.source_file,
            has_context=bool(row.project_context or row.sku_context),
            project_tier=row.project_tier,
            vat_enabled=row.vat_enabled,
        )
        for row in rows
    ]


@router.post('/projects', response_model=ProjectItem)
def create_project(
    payload: ProjectCreate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
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
        project_tier=payload.project_tier,
        vat_enabled=payload.vat_enabled,
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
    db: Session = Depends(get_primary_db_session),
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
        payload.is_active,
        project_tier=payload.project_tier,
        vat_enabled=payload.vat_enabled,
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


@router.post('/projects/{project_id}/move-{direction}', response_model=ProjectItem)
def move_project(
    project_id: int,
    direction: str,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectItem:
    """Move a project up or down in the sort order."""
    if direction not in ('up', 'down'):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="direction must be 'up' or 'down'")
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    row = project_service.reorder_project(db, project_id, direction)
    after = _serialize_project_item(row)
    append_operation_audit_log(
        db,
        action=f'projects.move_{direction}',
        target_type='project',
        target_id=project_id,
        operator=operator,
        after=after,
        request=request,
    )
    db.commit()
    return ProjectItem(**after)


@router.get('/projects/{project_id}/context', response_model=ProjectContextResponse)
def get_project_context_endpoint(
    project_id: int,
    request: Request,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectContextResponse:
    """Get project context configuration."""
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    project_context, sku_context = project_service.get_project_context(db, project_id)
    row = db.get(Project, project_id)
    append_operation_view_log(
        db,
        action='projects.context.view',
        target_type='project_context',
        target_id=project_id,
        operator=operator,
        after={'has_project_context': project_context is not None, 'has_sku_context': sku_context is not None},
        request=request,
    )
    db.commit()
    return ProjectContextResponse(
        project_id=project_id,
        project_name=row.project_name,
        project_context=project_context or {},
        sku_context=sku_context or {},
    )


@router.patch('/projects/{project_id}/context', response_model=ProjectContextResponse)
def update_project_context_endpoint(
    project_id: int,
    payload: ProjectContextUpdate,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> ProjectContextResponse:
    """Update project context configuration (JSON Merge Patch semantics)."""
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    before_project_context, before_sku_context = project_service.get_project_context(db, project_id)
    before = {"project_context": before_project_context, "sku_context": before_sku_context}

    row = project_service.update_project_context(
        db,
        project_id,
        project_context=payload.project_context,
        sku_context=payload.sku_context,
        operator=operator,
    )

    append_operation_audit_log(
        db,
        action='projects.context.update',
        target_type='project_context',
        target_id=project_id,
        operator=operator,
        before=before,
        after={"project_context": row.project_context, "sku_context": row.sku_context},
        request=request,
    )
    db.commit()

    return ProjectContextResponse(
        project_id=project_id,
        project_name=row.project_name,
        project_context=row.project_context or {},
        sku_context=row.sku_context or {},
    )


@router.post(
    "/projects/{project_id}/context/parse",
    response_model=ParseContextResponse,
)
def parse_project_context_endpoint(
    project_id: int,
    payload: ParseContextRequest,
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> ParseContextResponse:
    """
    使用 AI 将自然语言描述解析为项目背景配置 JSON。
    """
    from app.core.config import get_settings
    from app.services.ai.context_parser import parse_context_sync

    settings = get_settings()
    result = parse_context_sync(payload.description, settings)

    if result is None:
        return ParseContextResponse(result={})

    return ParseContextResponse(result=result)

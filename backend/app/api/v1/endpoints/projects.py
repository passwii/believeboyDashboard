from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.core.config import get_settings
from app.schemas.project import ProjectCreate, ProjectItem, ProjectOption, ProjectUpdate
from app.services import product_cost_cache_service, project_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/projects')
def list_projects(db: Session = Depends(get_db_session)) -> list[ProjectOption]:
    settings = get_settings()
    cached_payload = product_cost_cache_service.get_cached_projects_options(settings)
    if cached_payload is not None:
        return [ProjectOption(**item) for item in cached_payload]

    payload = project_service.list_project_options(db)
    product_cost_cache_service.set_cached_projects_options(settings, payload)
    return [ProjectOption(**item) for item in payload]


@router.get('/projects/manage')
def list_projects_manage(db: Session = Depends(get_db_session)) -> list[ProjectItem]:
    settings = get_settings()
    cached_payload = product_cost_cache_service.get_cached_projects_manage(settings)
    if cached_payload is not None:
        return [ProjectItem(**item) for item in cached_payload]

    rows = project_service.list_project_items(db)
    payload = [
        ProjectItem(
            id=row.id,
            name=row.project_name,
            brand_name=row.brand_name,
            store_address=row.store_address,
            sort_order=row.sort_order,
            source_file=row.source_file,
        )
        for row in rows
    ]
    product_cost_cache_service.set_cached_projects_manage(settings, [item.model_dump() for item in payload])
    return payload


@router.post('/projects', response_model=ProjectItem)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db_session)) -> ProjectItem:
    settings = get_settings()
    row = project_service.create_single_project(
        db,
        payload.name,
        payload.brand_name,
        payload.store_address,
    )
    db.commit()
    product_cost_cache_service.invalidate_projects_cache(settings)
    return ProjectItem(
        id=row.id,
        name=row.project_name,
        brand_name=row.brand_name,
        store_address=row.store_address,
        sort_order=row.sort_order,
        source_file=row.source_file,
    )


@router.patch('/projects/{project_id}', response_model=ProjectItem)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db_session)) -> ProjectItem:
    settings = get_settings()
    row = project_service.update_project(
        db,
        project_id,
        payload.name,
        payload.brand_name,
        payload.store_address,
    )
    db.commit()
    product_cost_cache_service.invalidate_projects_cache(settings)
    return ProjectItem(
        id=row.id,
        name=row.project_name,
        brand_name=row.brand_name,
        store_address=row.store_address,
        sort_order=row.sort_order,
        source_file=row.source_file,
    )

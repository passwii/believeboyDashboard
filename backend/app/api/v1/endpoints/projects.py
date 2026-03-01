from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.schemas.project import ProjectCreate, ProjectItem, ProjectOption, ProjectUpdate
from app.services import project_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/projects')
def list_projects(db: Session = Depends(get_db_session)) -> list[ProjectOption]:
    payload = project_service.list_project_options(db)
    return [ProjectOption(**item) for item in payload]


@router.get('/projects/manage')
def list_projects_manage(db: Session = Depends(get_db_session)) -> list[ProjectItem]:
    rows = project_service.list_project_items(db)
    return [
        ProjectItem(
            id=row.id,
            name=row.project_name,
            brand_name=row.brand_name,
            store_address=row.store_address,
            project_operator=row.project_operator,
            commission_basis=row.commission_basis,
            commission_rate=float(row.commission_rate) if row.commission_rate is not None else None,
            sort_order=row.sort_order,
            source_file=row.source_file,
        )
        for row in rows
    ]


@router.post('/projects', response_model=ProjectItem)
def create_project(payload: ProjectCreate, db: Session = Depends(get_db_session)) -> ProjectItem:
    row = project_service.create_single_project(
        db,
        payload.name,
        payload.brand_name,
        payload.store_address,
        payload.project_operator,
        payload.commission_basis,
        payload.commission_rate,
    )
    db.commit()
    return ProjectItem(
        id=row.id,
        name=row.project_name,
        brand_name=row.brand_name,
        store_address=row.store_address,
        project_operator=row.project_operator,
        commission_basis=row.commission_basis,
        commission_rate=float(row.commission_rate) if row.commission_rate is not None else None,
        sort_order=row.sort_order,
        source_file=row.source_file,
    )


@router.patch('/projects/{project_id}', response_model=ProjectItem)
def update_project(project_id: int, payload: ProjectUpdate, db: Session = Depends(get_db_session)) -> ProjectItem:
    row = project_service.update_project(
        db,
        project_id,
        payload.name,
        payload.brand_name,
        payload.store_address,
        payload.project_operator,
        payload.commission_basis,
        payload.commission_rate,
    )
    db.commit()
    return ProjectItem(
        id=row.id,
        name=row.project_name,
        brand_name=row.brand_name,
        store_address=row.store_address,
        project_operator=row.project_operator,
        commission_basis=row.commission_basis,
        commission_rate=float(row.commission_rate) if row.commission_rate is not None else None,
        sort_order=row.sort_order,
        source_file=row.source_file,
    )

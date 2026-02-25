from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.services import product_cost_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get('/projects')
def list_projects(db: Session = Depends(get_db_session)) -> list[dict[str, str]]:
    return product_cost_service.list_projects(db)

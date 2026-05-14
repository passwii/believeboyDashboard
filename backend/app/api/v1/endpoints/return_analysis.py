from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.return_analysis import ReturnAnalysisResponse
from app.services import project_service
from app.services.analysis.return_analysis import build_return_analysis

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/return-analysis", response_model=ReturnAnalysisResponse)
def get_return_analysis(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """获取退货分析数据"""
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return build_return_analysis(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )

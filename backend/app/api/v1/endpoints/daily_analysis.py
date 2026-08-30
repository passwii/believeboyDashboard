from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, get_request_operator, protected
from app.schemas.daily_analysis import (
    DailyAnalysisAllCountriesResponse,
    DailyAnalysisAllProjectsCountriesResponse,
    DailyAnalysisAllProjectsResponse,
    DailyAnalysisResponse,
)
from app.services.daily import (
    build_daily_analysis,
    build_daily_analysis_all_countries,
    build_daily_analysis_all_projects,
    build_daily_analysis_all_projects_countries,
)
from app.services import project_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/daily-analysis", response_model=DailyAnalysisResponse)
def get_daily_analysis(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    no_cache: bool = Query(default=False),
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return build_daily_analysis(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
        no_cache=no_cache,
    )


@router.get("/daily-analysis/all", response_model=DailyAnalysisAllProjectsResponse)
def get_daily_analysis_all(
    project_ids: Annotated[str, Query(description="comma-separated project IDs")],
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    try:
        ids = [int(x.strip()) for x in project_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="project_ids must be comma-separated integers",
        )
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="at least one project_id is required",
        )

    normalized_operator = (operator or "").strip()
    for pid in ids:
        project_service.ensure_project_access(
            db,
            pid,
            operator=normalized_operator,
            is_admin=bool(is_admin),
        )

    return build_daily_analysis_all_projects(
        db,
        project_ids=ids,
        country=country,
        start_date=start_date,
        end_date=end_date,
        sku=sku,
    )


@router.get("/daily-analysis/all-countries", response_model=DailyAnalysisAllCountriesResponse)
def get_daily_analysis_all_countries(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """跨国家站点聚合单项目数据。

    当前对 US / DE / UK 三个国家分别加载数据并按 (date, sku) 求和；
    响应里 ``country_breakdown`` 字段给出按国家分桶的明细。
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )
    return build_daily_analysis_all_countries(
        db,
        project_id=project_id,
        start_date=start_date,
        end_date=end_date,
    )


@router.get(
    "/daily-analysis/all-projects-countries",
    response_model=DailyAnalysisAllProjectsCountriesResponse,
)
def get_daily_analysis_all_projects_countries(
    project_ids: Annotated[str, Query(description="comma-separated project IDs")],
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """全部项目 × 全部国家站点聚合（BLF-913，USD 基准）。

    对每个 (project, country) 组合装载 US/DE/UK metrics，金额字段按当月
    汇率折算成 USD 后合并；响应同时给出 ``project_breakdown``（项目跨
    国家合并）与 ``country_breakdown``（国家跨项目合并）。
    """
    try:
        ids = [int(x.strip()) for x in project_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="project_ids must be comma-separated integers",
        )
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="at least one project_id is required",
        )

    normalized_operator = (operator or "").strip()
    for pid in ids:
        project_service.ensure_project_access(
            db,
            pid,
            operator=normalized_operator,
            is_admin=bool(is_admin),
        )

    return build_daily_analysis_all_projects_countries(
        db,
        project_ids=ids,
        start_date=start_date,
        end_date=end_date,
    )

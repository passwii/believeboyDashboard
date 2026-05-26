"""Dashboard KPI 总览 API 端点"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_is_admin, get_request_operator, protected
from app.schemas.dashboard_overview import DashboardOverviewResponse
from app.services import dashboard_overview_service

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/dashboard/overview", response_model=DashboardOverviewResponse)
def get_dashboard_overview(
    country: str = Query(default="US"),
    days: Annotated[int, Query(ge=1, le=30)] = 7,
    project_ids: Annotated[str | None, Query(description="comma-separated project IDs")] = None,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> DashboardOverviewResponse:
    """
    Dashboard KPI 总览聚合接口。

    - 返回当前用户可访问的所有项目的汇总 KPI 数据（销售、库存、发货、退货、广告）
    - 支持按项目 ID 筛选（逗号分隔），支持按国家筛选
    - 数据来自 digital_display_service 的各子模块
    """
    parsed_ids: list[int] | None = None
    if project_ids:
        try:
            parsed_ids = [int(x.strip()) for x in project_ids.split(",") if x.strip()]
        except ValueError:
            parsed_ids = None

    payload = dashboard_overview_service.build_dashboard_overview(
        db=db,
        project_ids=parsed_ids,
        operator=operator,
        is_admin=is_admin,
        country=country,
        days=days,
    )
    return DashboardOverviewResponse(**payload)
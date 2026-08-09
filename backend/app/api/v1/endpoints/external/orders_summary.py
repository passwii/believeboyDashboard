"""Orders Summary endpoint for the external API.

GET /api/v1/external/projects/{project_id}/orders/summary
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Union

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_countries
from app.api.v1.endpoints.external._period import parse_period_v2
from app.schemas.external.orders_summary import (
    OrdersGroupedResponse,
    OrdersSummaryResponse,
)
from app.services.external import orders_summary, projects_query

router = APIRouter()


@router.get(
    "/projects/{project_id}/orders/summary",
    response_model=Union[OrdersSummaryResponse, OrdersGroupedResponse],
)
def get_external_orders_summary(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    include_cancelled: bool = Query(default=False),
    include_pending: bool = Query(default=True),
    aggregate: bool = Query(default=True),
    # BLF-558: group_by 模式（spec §4.2）——缺省 = 现有原始行行为，向后兼容。
    group_by: str = Query(default=""),  # "asin" | "asin_day" | "day"
    order_by: str = Query(default="sales_amount"),
    order_dir: str = Query(default="desc"),
    include_share: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> Union[OrdersSummaryResponse, OrdersGroupedResponse]:
    today_minus_one = date.today() - timedelta(days=1)
    try:
        # BLF-560 v0.2：country 支持逗号分隔多站点（group_by 模式生效）；
        # 单站点行为与 parse_country 完全一致（向后兼容）。
        countries = parse_countries(country)
        period_info = parse_period_v2(
            period,
            start_date,
            end_date,
            today=today_minus_one,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # BLF-558: group_by 模式白名单校验（spec §4.2）——非法值 → 400
    # （agent 镜像经 _service_errors 翻译成 VALIDATION_FAILED 壳）。
    # 非 group_by 模式不做校验：order_by/order_dir 此时无意义且存量消费者
    # 可能传任意值（向后兼容）。
    if group_by:
        if group_by not in orders_summary.GROUP_BY_ALLOWED:
            raise HTTPException(
                status_code=400,
                detail=(
                    "group_by 必须是白名单之一"
                    f"（{'/'.join(sorted(orders_summary.GROUP_BY_ALLOWED))}），"
                    f"收到 {group_by!r}"
                ),
            )
        if order_by not in orders_summary.ORDER_BY_ALLOWED:
            raise HTTPException(
                status_code=400,
                detail=(
                    "order_by 必须是白名单之一"
                    f"（{'/'.join(sorted(orders_summary.ORDER_BY_ALLOWED))}），"
                    f"收到 {order_by!r}"
                ),
            )
        order_dir_norm = order_dir.lower()
        if order_dir_norm not in orders_summary.ORDER_DIR_ALLOWED:
            raise HTTPException(
                status_code=400,
                detail=(f"order_dir 必须是白名单之一（desc/asc），收到 {order_dir!r}"),
            )
    else:
        order_dir_norm = order_dir.lower()
        # BLF-560 v0.2：多站点聚合仅 group_by 模式支持——非 group_by 模式
        # （原始行 + 页内汇总）混币种无意义（不做跨币种求和），显式 400。
        if len(countries) > 1:
            raise HTTPException(
                status_code=400,
                detail=(
                    "多站点聚合（country 逗号分隔多值）仅支持 group_by 模式；"
                    f"收到 {country!r}"
                ),
            )

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    if group_by:
        rows, total_rows, agg = orders_summary.query_orders_summary_grouped(
            db,
            project_id=project_id,
            country=countries,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
            include_cancelled=include_cancelled,
            include_pending=include_pending,
            group_by=group_by,
            order_by=order_by,
            order_dir=order_dir_norm,
            include_share=include_share,
            # spec §4.2：group_by 模式下 limit 默认 500（作用于聚合行）。
            limit=limit if limit is not None else 500,
            offset=offset,
        )
        return OrdersGroupedResponse(
            project_id=project_id,
            period=period_info,
            country=",".join(countries),
            countries=countries,
            group_by=group_by,
            rows=rows,
            total_rows=total_rows,
            summary=agg,
        )

    normalized_country = countries[0]
    rows, agg = orders_summary.query_orders_summary(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=period_info.start_date,
        date_to=period_info.end_date,
        include_cancelled=include_cancelled,
        include_pending=include_pending,
        aggregate=aggregate,
        limit=limit if limit is not None else 50000,
        offset=offset,
    )

    return OrdersSummaryResponse(
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=rows,
        aggregate=agg if aggregate else None,
        summary=agg,
    )

"""Agent 销售数据域路由（BLF-569：orders/summary → sales/summary 迁移）。

在 ``/api/v1/agent/projects/{project_id}/sales/summary`` 开放 1 条读路由
（域 code 从 ``orders`` 迁移为 ``sales``：复用 external service +
``_service_errors`` 壳 + ``agent_ok`` 响应壳，挂 ``require_project_scope``
——对齐 return_analysis / account_health 等原生域模板）。

BLF-569 路径迁移（用户 2026-08-09 拍板；对齐 BLF-459 三阶段：双挂 → 切换
→ 下线）：

* **新原生路径**：``/sales/summary``（本模块主路由，spec v0.3 §4.1）。
* **旧路径双挂 + 迁移提示**：``/orders/summary`` 保留期间返回
  ``Deprecation`` / ``Sunset`` / ``Link: rel="successor-version"`` 头
  （对齐 BLF-459 v1 双挂先例），行为与 sales/summary 完全一致（数据零漂移），
  消费者有时间切换。
* **域级权限门**：``require_business_scope("sales")`` 在 ``agent/__init__.py``
  装配时挂载（本模块不重复挂）——key 无 ``sales`` 域 → 403
  ``AGENT_BUSINESS_OUT_OF_SCOPE``；``business_scope="*"`` → 放行（存量 key 兼容）。
* **镜像侧**：``external_mirror._EXCLUDED_EXTERNAL_PATHS`` 已排除
  ``/external/projects/{project_id}/orders/summary``（external 源路由不动，
  仅作 handler 来源），无双挂冲突；sales/summary 不在 external 源中，无镜像。

参数契约与 external handler 完全一致（period/country/group_by/order_by/
order_dir/include_share/limit/offset），响应形状与 ``OrdersGroupedResponse`` /
``OrdersSummaryResponse`` 的 ``model_dump`` 一致（双通道数据零漂移）。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.api.v1.endpoints.external._helpers import parse_countries
from app.api.v1.endpoints.external._period import parse_period_v2
from app.schemas.external.orders_summary import (
    OrdersGroupedResponse,
    OrdersSummaryResponse,
)
from app.services.external import orders_summary, projects_query

# BLF-569 旧路径下线预告（BLF-459 v1 同款 Sunset 语义）：消费者须在
# 该日期前从 /orders/summary 切到 /sales/summary；届时执行 v3 下线。
_LEGACY_PATH_SUNSET = "2026-12-31"

sales_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-sales"],
)


@contextmanager
def _service_errors():
    """把 service 层 HTTPException 翻译成 agent 响应壳（设计稿 §5）。"""
    try:
        yield
    except AgentApiError:
        raise
    except HTTPException as exc:
        detail = str(exc.detail) if exc.detail else None
        if exc.status_code == 404:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND, human_message=detail
            ) from None
        raise AgentApiError(ErrorCode.VALIDATION_FAILED, human_message=detail) from None


def _mark_legacy_deprecation(response: Response, project_id: int) -> None:
    """旧路径 /orders/summary 迁移提示头（BLF-569 双挂期，对齐 BLF-459 v1）。

    * ``Deprecation: true``
    * ``Sunset: <_LEGACY_PATH_SUNSET>``
    * ``Link: </api/v1/agent/projects/{id}/sales/summary>; rel="successor-version"``
      ——指向新路径，等效 301 的 successor 提示。
    """
    response.headers["Deprecation"] = "true"
    response.headers["Sunset"] = _LEGACY_PATH_SUNSET
    response.headers["Link"] = (
        f'</api/v1/agent/projects/{project_id}/sales/summary>; rel="successor-version"'
    )


@sales_router.get("/sales/summary")
def get_agent_sales_summary(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    include_cancelled: bool = Query(default=False),
    include_pending: bool = Query(default=True),
    aggregate: bool = Query(default=True),
    group_by: str = Query(default=""),  # "asin" | "asin_day" | "day"
    order_by: str = Query(default="sales_amount"),
    order_dir: str = Query(default="desc"),
    include_share: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """sales/summary 原生路由（BLF-569 迁移后主路径）。

    查询契约与 external handler 完全一致（spec v0.2 §4.2）：``country`` 支持
    逗号分隔多站点（group_by 模式）；``group_by=asin|asin_day|day`` 聚合 +
    派生指标；``summary.by_country`` 按国家分拆金额（不做跨币种求和）。
    """
    with _service_errors():
        today_minus_one = date.today() - timedelta(days=1)
        try:
            countries = parse_countries(country)
            period_info = parse_period_v2(
                period,
                start_date,
                end_date,
                today=today_minus_one,
            )
        except Exception as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=str(exc)
            ) from None

        if group_by:
            if group_by not in orders_summary.GROUP_BY_ALLOWED:
                raise AgentApiError(
                    ErrorCode.VALIDATION_FAILED,
                    human_message=(
                        "group_by 必须是白名单之一"
                        f"（{'/'.join(sorted(orders_summary.GROUP_BY_ALLOWED))}），"
                        f"收到 {group_by!r}"
                    ),
                )
            if order_by not in orders_summary.ORDER_BY_ALLOWED:
                raise AgentApiError(
                    ErrorCode.VALIDATION_FAILED,
                    human_message=(
                        "order_by 必须是白名单之一"
                        f"（{'/'.join(sorted(orders_summary.ORDER_BY_ALLOWED))}），"
                        f"收到 {order_by!r}"
                    ),
                )
            order_dir_norm = order_dir.lower()
            if order_dir_norm not in orders_summary.ORDER_DIR_ALLOWED:
                raise AgentApiError(
                    ErrorCode.VALIDATION_FAILED,
                    human_message=(
                        f"order_dir 必须是白名单之一（desc/asc），收到 {order_dir!r}"
                    ),
                )
        else:
            order_dir_norm = order_dir.lower()
            # v0.2：多站点聚合仅 group_by 模式支持（混币种原始行无意义）。
            if len(countries) > 1:
                raise AgentApiError(
                    ErrorCode.VALIDATION_FAILED,
                    human_message=(
                        "多站点聚合（country 逗号分隔多值）仅支持 group_by 模式；"
                        f"收到 {country!r}"
                    ),
                )

        if not projects_query.project_exists(db, project_id):
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"project {project_id} not found",
            )

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
                limit=limit if limit is not None else 500,
                offset=offset,
            )
            payload = OrdersGroupedResponse(
                project_id=project_id,
                period=period_info,
                country=",".join(countries),
                countries=countries,
                group_by=group_by,
                rows=rows,
                total_rows=total_rows,
                summary=agg,
            ).model_dump(mode="json")
        else:
            rows, agg = orders_summary.query_orders_summary(
                db,
                project_id=project_id,
                country=countries[0],
                date_from=period_info.start_date,
                date_to=period_info.end_date,
                include_cancelled=include_cancelled,
                include_pending=include_pending,
                aggregate=aggregate,
                limit=limit if limit is not None else 50000,
                offset=offset,
            )
            payload = OrdersSummaryResponse(
                project_id=project_id,
                period=period_info,
                country=countries[0],
                data=rows,
                aggregate=agg if aggregate else None,
                summary=agg,
            ).model_dump(mode="json")

    return agent_ok(payload)


@sales_router.get("/orders/summary")
def get_agent_orders_summary_legacy(
    response: Response,
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    include_cancelled: bool = Query(default=False),
    include_pending: bool = Query(default=True),
    aggregate: bool = Query(default=True),
    group_by: str = Query(default=""),  # "asin" | "asin_day" | "day"
    order_by: str = Query(default="sales_amount"),
    order_dir: str = Query(default="desc"),
    include_share: bool = Query(default=False),
    limit: int | None = Query(default=None, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """orders/summary 旧路径（BLF-569 双挂迁移提示期）。

    行为与 ``/sales/summary`` 完全一致（同一实现，数据零漂移），仅额外返回
    迁移提示头：``Deprecation: true`` + ``Sunset`` + ``Link:
    rel="successor-version"`` 指向新路径——对齐 BLF-459 v1 双挂先例。
    下线（v3 410）由后续 issue 在 Sunset 之后执行。
    """
    _mark_legacy_deprecation(response, project_id)
    return get_agent_sales_summary(
        project_id=project_id,
        period=period,
        start_date=start_date,
        end_date=end_date,
        country=country,
        include_cancelled=include_cancelled,
        include_pending=include_pending,
        aggregate=aggregate,
        group_by=group_by,
        order_by=order_by,
        order_dir=order_dir,
        include_share=include_share,
        limit=limit,
        offset=offset,
        db=db,
    )

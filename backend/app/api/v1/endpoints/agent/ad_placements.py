
"""Agent 广告展示位域路由（BLF-581 原生化）。

在 ``/api/v1/agent/projects/{project_id}/ad-placements*`` 开放读路由
（aggregate + raw+ raw 单数 alias），**原生替换 external 镜像**
（BLF-459 P1 镜像复用；external/ad_placements.py 端点模块已删除，BLF-581）：

* ``/ad-placements``            — 按业务键聚合
* ``/ad-placements-raw``        — 深诊断原始行
* ``/ad-placement-raw``  — 单数 alias（与镜像时代路径面保持一致）

响应形状与镜像产出一致（``AdPlacementAggregateResponse`` / ``RawResponse[AdPlacementRawRow]``
的 ``model_dump(mode="json")``），parity 测试锁定（agent 通道 == service 直调）。

* **域级权限门**：``require_business_scope("ad_analysis")`` 在
  ``agent/__init__.py`` 装配时挂载（本模块不重复挂）——既有 ad 域 scope
  约定（前端 ``agent-domains.ts`` 注册表 + 审计操作类型均为 ``ad_analysis``）。
* **服务层复用**：``ad_rows_query`` / ``aggregator`` / ``ad_raw`` /
  ``aggregate`` schemas 按「共享层可复用」原则保留，本模块显式调用，不再
  依赖 mirror 包裹。
* **internal 复用**：``get_ad_placement_raw_bare`` 无壳 raw handler（签名与删除前的
  ``get_external_ad_placement_raw`` 完全一致）供 ``/internal/ad-data`` 浏览器通道
  复用（BLF-459 V3 重建），返回 ``RawResponse`` 模型不包 agent 壳。
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.response import agent_ok
from app.api.agent.scope import require_project_scope
from app.api.deps import get_read_db_session
from app.api.v1.endpoints.agent._helpers import parse_country
from app.utils.period import parse_period_v2
from app.api.v1.endpoints.agent._whitelist import parse_order_by
from app.models import AdUploadPlacementRow
from app.schemas.external.ad_raw import AdPlacementRawRow
from app.schemas.external.aggregate import (
    AdPlacementAggregateResponse,
    AdPlacementAggregateRow,
    RawResponse,
    RawSummary,
)
from app.services.external import ad_rows_query, aggregator, projects_query

ad_placements_router = APIRouter(
    prefix="/projects/{project_id}",
    tags=["agent-ad-placements"],
)


# ============================================================
# 壳翻译与解析 helper（对齐 sales / return_analysis 域模板）
# ============================================================

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


def _parse_period(period: str, start_date: str | None, end_date: str | None):
    """period / start_date / end_date → PeriodInfo（T-1 锚定，对齐 external）。"""
    return parse_period_v2(
        period,
        start_date,
        end_date,
        today=date.today() - timedelta(days=1),
    )


# ============================================================
# Aggregate 端点（agent 原生）
# ============================================================

@ad_placements_router.get("/ad-placements")
def get_agent_ad_placement_aggregate(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """ad-placements 聚合：按业务键汇总 spend / sales / orders 等。

    查询契约与删除前的 external handler 完全一致（period/country 参数语义、
    白名单 order 列、AggregateResponse 形状）。
    """
    with _service_errors():
        try:
            normalized_country = parse_country(country)
            period_info = _parse_period(period, start_date, end_date)
        except Exception as exc:
            raise AgentApiError(
                ErrorCode.VALIDATION_FAILED, human_message=str(exc)
            ) from None

        if not projects_query.project_exists(db, project_id):
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message=f"project {project_id} not found",
            )

        rows = aggregator.aggregate_placements(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
        )
        payload = AdPlacementAggregateResponse(
            project_id=project_id,
            period=period_info,
            country=normalized_country,
            data=[AdPlacementAggregateRow.model_validate(r) for r in rows],
            summary=aggregator.build_aggregate_summary(rows),
        ).model_dump(mode="json")

    return agent_ok(payload)


# ============================================================
# Raw 端点（agent 原生 + internal/ad-data 无壳复用）
# ============================================================

def get_ad_placement_raw_bare(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="report_end_date"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
) -> RawResponse[AdPlacementRawRow]:
    """无壳 raw handler（BLF-581 原生化：从 external 模块搬入 agent 域模块）。

    签名与删除前的 ``get_external_ad_placement_raw`` 完全一致，返回
    ``RawResponse[AdPlacementRawRow]`` 模型、抛 ``HTTPException``——供
    ``/internal/ad-data`` 浏览器通道复用（响应形状
    ``{project_id, period, country, data, summary}`` 不变）。
    """
    today_minus_one = date.today() - timedelta(days=1)
    try:
        normalized_country = parse_country(country)
        period_info = parse_period_v2(
            period,
            start_date,
            end_date,
            today=today_minus_one,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    try:
        order_column, direction = parse_order_by(
            order_by,
            order_dir,
            model=AdUploadPlacementRow,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        rows = ad_rows_query.query_placement_raw(
            db,
            project_id=project_id,
            country=normalized_country,
            date_from=period_info.start_date,
            date_to=period_info.end_date,
            order_column=order_column,
            order_dir=direction,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return RawResponse[AdPlacementRawRow](
        project_id=project_id,
        period=period_info,
        country=normalized_country,
        data=[AdPlacementRawRow.model_validate(r) for r in rows],
        summary=RawSummary(
            total_rows=len(rows),
            date_range=[
                period_info.start_date.isoformat(),
                period_info.end_date.isoformat(),
            ],
        ),
    )



@ad_placements_router.get("/ad-placements-raw")
def get_agent_ad_placement_raw(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="report_end_date"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """ad-placements-raw：深诊断原始行（与删除前的 external handler 同契约）。"""
    with _service_errors():
        resp = get_ad_placement_raw_bare(
            project_id=project_id,
            period=period,
            start_date=start_date,
            end_date=end_date,
            country=country,
            limit=limit,
            offset=offset,
            order_by=order_by,
            order_dir=order_dir,
            db=db,
        )
    return agent_ok(resp.model_dump(mode="json"))



@ad_placements_router.get("/ad-placement-raw")
def get_agent_ad_placement_raw_alias(
    project_id: int = Path(..., ge=1),
    period: str = Query(default=""),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    country: str = Query(default=""),
    limit: int = Query(default=10000, ge=1, le=50000),
    offset: int = Query(default=0, ge=0),
    order_by: str = Query(default="report_end_date"),
    order_dir: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_read_db_session),
    _scope=Depends(require_project_scope),
) -> dict:
    """单数 alias：``ad-placement-raw``（镜像时代路径面，保留不漂移）。"""
    with _service_errors():
        resp = get_ad_placement_raw_bare(
            project_id=project_id,
            period=period,
            start_date=start_date,
            end_date=end_date,
            country=country,
            limit=limit,
            offset=offset,
            order_by=order_by,
            order_dir=order_dir,
            db=db,
        )
    return agent_ok(resp.model_dump(mode="json"))


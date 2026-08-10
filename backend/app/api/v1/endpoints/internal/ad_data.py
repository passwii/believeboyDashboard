"""内部 ad-data 读路由（BLF-459 V3：/external/* 下线后，浏览器端用 /internal）。

设计稿 §1.1：``/internal/*`` 给人/UI 用。ad-data 页（报表数据查看器）原直连
``/external/.../ad-{endpoint}-raw`` 与 ``/external/.../ad-upload-files``——
V3 起 external 命名空间整体 410，这里在 internal 下重建同构读路由：

* ``GET /internal/ad-data/projects/{project_id}/ad-upload-files``
  —— 恢复 list_ad_upload_files（BEL-378 移除前的外部端点同构，浏览器需要它
  判断"哪些报表类型有成功入库数据"）。
* ``GET /internal/ad-data/projects/{project_id}/ad-{endpoint}-raw``
  —— 复用 external raw handler（programmatic 镜像，路径后缀与 external 一致）。

鉴权：``protected``（require_api_key，走 /api/backend 代理的 X-API-Key /
?api_key=）。纯读，不落审计。
"""

from __future__ import annotations

import types
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, protected
from app.api.v1.endpoints.agent.ad_campaigns import get_ad_campaign_raw_bare
from app.api.v1.endpoints.external import ad_budgets, ad_targets
from app.api.v1.endpoints.external import (
    ad_invalid_traffic,
    ad_placements,
    ad_promoted_products,
    ad_purchased_products,
    ad_search_term_shares,
    ad_search_terms,
    ad_time_trends,
)
from app.models.ad_upload import AdUploadFile
from app.schemas.external.ad_upload_files import AdUploadFileItem
from app.services.external import ad_rows_query, projects_query


router = APIRouter(
    prefix="/internal/ad-data",
    tags=["internal-ad-data"],
    dependencies=[Depends(protected)],
)


# ============================================================
# ad-upload-files（恢复：浏览器判断报表类型有无数据）
# ============================================================


@router.get(
    "/projects/{project_id}/ad-upload-files",
    response_model=list[AdUploadFileItem],
)
def list_ad_upload_files(
    project_id: int = Path(..., ge=1),
    report_type: str | None = Query(default=None),
    country: str | None = Query(default=None),
    include_history: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_read_db_session),
) -> list[AdUploadFileItem]:
    """列出项目已入库的广告报表文件（当前版本优先，按 updated_at 倒序）。"""
    if not projects_query.project_exists(db, project_id):
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")

    try:
        files = ad_rows_query.list_ad_upload_files(
            db,
            project_id=project_id,
            report_type=report_type,
            country=country,
            include_history=include_history,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return [
        AdUploadFileItem(
            file_id=f.id,
            report_type=f.report_type,
            report_label=f.report_label,
            country=f.country,
            period_start_date=f.period_start_date,
            period_end_date=f.period_end_date,
            version=f.version,
            is_current=f.is_current,
            ingestion_status=f.ingestion_status,
            row_count_preview=f.row_count_preview,
            uploaded_at=f.created_at,
        )
        for f in files
    ]


# ============================================================
# ad-{endpoint}-raw 镜像（复用 external raw handler）
# ============================================================


def _wrap_raw_handler(endpoint: Callable, *, name: str) -> Callable:
    """调 external raw handler → 直接返回其 pydantic 模型（浏览器形态不变）。

    external handler 的 raw 路由返回 ``RawResponse[...]``（project_id /
    period / country / data / summary），与 ad-data 页期望一致——不需要
    agent 壳，原样透传。
    """
    from fastapi.params import Param

    def _call(*args: Any, **kwargs: Any) -> Any:
        try:
            return endpoint(*args, **kwargs)
        except HTTPException:
            raise

    globals_ = dict(endpoint.__globals__)
    wrapped = types.FunctionType(
        _call.__code__,
        globals_,
        name=name,
        argdefs=_call.__defaults__,
        closure=_call.__closure__,
    )
    wrapped.__wrapped__ = endpoint
    return wrapped


_RAW_HANDLERS: dict[str, Callable] = {
    "ad-campaigns": get_ad_campaign_raw_bare,
    "ad-search-terms": ad_search_terms.get_external_ad_search_term_raw,
    "ad-budgets": ad_budgets.get_external_ad_budget_raw,
    "ad-targets": ad_targets.get_external_ad_target_raw,
    "ad-placements": ad_placements.get_external_ad_placement_raw,
    "ad-promoted-products": ad_promoted_products.get_external_ad_promoted_product_raw,
    "ad-time-trends": ad_time_trends.get_external_ad_time_trend_raw,
    "ad-search-term-shares": ad_search_term_shares.get_external_ad_search_term_share_raw,
    "ad-invalid-traffic": ad_invalid_traffic.get_external_ad_invalid_traffic_raw,
    "ad-purchased-products": ad_purchased_products.get_external_ad_purchased_product_raw,
}

for _endpoint, _handler in _RAW_HANDLERS.items():
    router.add_api_route(
        f"/projects/{{project_id}}/{_endpoint}-raw",
        endpoint=_wrap_raw_handler(_handler, name=f"internal_ad_data_{_endpoint}_raw"),
        methods=["GET"],
        name=f"internal_ad_data_{_endpoint}_raw",
        response_model=None,
    )

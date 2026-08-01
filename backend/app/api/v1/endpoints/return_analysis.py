from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, get_request_operator, protected
from app.schemas.return_analysis import ReturnAnalysisResponse
from app.services import project_service
from app.services.analysis.return_analysis import (
    build_return_analysis,
    build_return_analysis_from_snapshot,
    is_snapshot_fresh_for_range,
)
from app.services.infra.inventory_cache import (
    get_return_analysis_v2_cache,
    set_return_analysis_v2_cache,
)

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(protected)])


@router.get("/return-analysis", response_model=ReturnAnalysisResponse)
def get_return_analysis(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """获取退货分析数据

    BEL-373 双段式架构（plan §3.2）：
    1. Redis v2 缓存（5 分钟 TTL）→ 命中直接返回
    2. 缓存未命中 → 查 snapshot 是否新鲜（25h 阈值）
       - 新鲜：build_return_analysis_from_snapshot() 走物化表
       - 不新鲜：fallback 到 build_return_analysis() 现场跑
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    # ── Redis v2 cache: 5 min TTL ──
    cached = get_return_analysis_v2_cache(
        project_id, country, start_date, end_date, sku
    )
    if cached is not None:
        # 去掉辅助字段后构造响应（model_validate 会忽略多余字段）
        cached.pop("_cache_source", None)
        return ReturnAnalysisResponse(**cached)

    # ── Snapshot-or-fallback 双路径 ──
    if is_snapshot_fresh_for_range(
        db,
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
    ):
        try:
            result = build_return_analysis_from_snapshot(
                db,
                project_id=project_id,
                country=country,
                start_date=start_date,
                end_date=end_date,
                sku=sku,
            )
            source = "snapshot"
        except Exception as exc:  # 物化表路径出问题时降级到现场跑
            logger.warning(
                "snapshot path failed, fallback to live: project=%s err=%s",
                project_id,
                exc,
            )
            result = build_return_analysis(
                db,
                project_id=project_id,
                country=country,
                start_date=start_date,
                end_date=end_date,
                sku=sku,
            )
            source = "fallback"
    else:
        result = build_return_analysis(
            db,
            project_id=project_id,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=sku,
        )
        source = "fallback"

    # 写 v2 缓存（带 source 标记，便于 redis-monitor 调试）
    if hasattr(result, "model_dump"):
        set_return_analysis_v2_cache(
            project_id,
            country,
            start_date,
            end_date,
            sku,
            result.model_dump(mode="json"),
            source=source,
        )
    return result

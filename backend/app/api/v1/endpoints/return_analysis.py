from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.deps import get_read_db_session, get_request_operator, protected
from app.constants.return_thresholds import MAX_RAW_ROWS
from app.constants.return_translations import translate_return_field
from app.schemas.return_analysis import (
    ReturnAnalysisResponse,
    ReturnRawRowItem,
    ReturnRawRowsResponse,
)
from app.services import project_service
from app.services.analysis.return_analysis import (
    build_return_analysis,
    build_return_analysis_from_snapshot,
    is_snapshot_fresh_for_range,
    query_current_return_rows,
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


@router.get("/return-analysis/raw-rows", response_model=ReturnRawRowsResponse)
def get_return_analysis_raw_rows(
    project_id: int,
    start_date: Annotated[str, Query(min_length=10, max_length=10)],
    end_date: Annotated[str, Query(min_length=10, max_length=10)],
    country: str = "US",
    sku: Optional[str] = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias="X-Is-Admin"),
):
    """亚马逊退货报表原始行（该周期、当前生效版本）。

    与 /return-analysis 同口径（共用 query_current_return_rows），供前端
    「原始数据」Tab 与 Excel「亚马逊原始数据」sheet 使用。独立端点而非并入
    主响应：主响应与 Redis v2 缓存保持零改动（spec §2.1）。

    不做分页：真实数据量为单周期数十至数百行，上限 MAX_RAW_ROWS 兜底；
    超限显式 400 而不是静默截断（spec §2.4）。
    """
    project_service.ensure_project_access(
        db,
        project_id,
        operator=operator,
        is_admin=bool(is_admin),
    )

    # 这一段刻意写成行内注释而不是 docstring：FastAPI 会把路由 docstring 当作
    # OpenAPI description 输出，任何增删都会让 openapi.json 漂移。
    # - limit=MAX_RAW_ROWS + 1：把上限也压在 DB 读取侧（多读 1 条只为判定「超了」，
    #   不会进响应），避免超限周期把整表行 materialize 到内存。
    # - 日期长度已由 Query(min_length/max_length) 卡住，但 ``2026-13-99`` 这类
    #   10 字符非法日期要靠 date.fromisoformat 才会暴露 —— 那是客户端输入错误，
    #   转 422 而不是让它冒泡成 500。
    try:
        rows = query_current_return_rows(
            db,
            project_id=project_id,
            country=country,
            start_date=start_date,
            end_date=end_date,
            sku=sku,
            limit=MAX_RAW_ROWS + 1,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail="日期格式不合法，应为 YYYY-MM-DD",
        ) from exc

    if len(rows) > MAX_RAW_ROWS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"所选周期原始退货行超过上限 {MAX_RAW_ROWS} 条，"
                "请缩小日期范围后重试"
            ),
        )

    items = [
        ReturnRawRowItem(
            return_date=(
                row.return_date.isoformat()
                if hasattr(row.return_date, "isoformat")
                else str(row.return_date)
            ),
            original_return_datetime=row.original_return_datetime,
            order_id=row.order_id,
            sku=row.sku,
            asin=row.asin,
            fnsku=row.fnsku,
            product_name=row.product_name,
            quantity=row.quantity,
            fulfillment_center_id=row.fulfillment_center_id,
            detailed_disposition=row.detailed_disposition,
            disposition_display=translate_return_field(
                "disposition", row.detailed_disposition
            ),
            reason=row.reason,
            reason_display=translate_return_field("reason", row.reason),
            status=row.status,
            status_display=translate_return_field("status", row.status),
            license_plate_number=row.license_plate_number,
            customer_comment=row.customer_comments,
        )
        for row in rows
    ]

    return ReturnRawRowsResponse(
        project_id=project_id,
        country=country,
        start_date=start_date,
        end_date=end_date,
        row_count=len(items),
        rows=items,
    )

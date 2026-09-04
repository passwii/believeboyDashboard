import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.deps import (
    get_primary_db_session,
    get_read_db_session,
    get_request_is_admin,
    get_request_operator,
    protected,
)
from app.models import AIInsight, InsightStatus, InsightType, Project
from app.schemas.ai_insight import (
    InsightChunkResponse,
    InsightDetail,
    InsightDoneResponse,
    InsightGenerateRequest,
    InsightItem,
    InsightListResponse,
    InsightRetryResponse,
    InsightStatusResponse,
    InsightUpdateRequest,
)
from app.schemas.insight_schedule import (
    InsightScheduleCreate,
    InsightScheduleUpdate,
    InsightScheduleItem,
    InsightScheduleListResponse,
    InsightScheduleToggleResponse,
    InsightScheduleRunNowResponse,
    InsightScheduleDeleteResponse,
)
from app.celery_tasks.insights.generate import (
    generate_insight as celery_generate_insight,
)
from app.services import project_service
from app.services.infra import ai_cache  # noqa: F401 —— 触发 L2 域 invalidate_fn 注册
from app.services.infra.cache_decorator import invalidate_cache_on_commit
from app.services.ai_insight_generator import (
    normalize_insight_markdown,
)
from app.services.insight_schedule_service import (
    get_schedules,
    create_schedule,
    update_schedule,
    delete_schedule,
    toggle_schedule,
    run_schedule_now,
    ensure_schedule_access,
    calculate_date_range,
)


def _serialize_insight(row: AIInsight) -> InsightItem:
    return InsightItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        title=row.title,
        insight_type=row.insight_type.value
        if isinstance(row.insight_type, InsightType)
        else row.insight_type,
        date_range_start=row.date_range_start,
        date_range_end=row.date_range_end,
        status=row.status.value
        if isinstance(row.status, InsightStatus)
        else row.status,
        sub_status=row.sub_status,
        error_message=row.error_message,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _serialize_insight_detail(row: AIInsight) -> InsightDetail:
    return InsightDetail(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        title=row.title,
        content=normalize_insight_markdown(row.content or ""),
        insight_type=row.insight_type.value
        if isinstance(row.insight_type, InsightType)
        else row.insight_type,
        date_range_start=row.date_range_start,
        date_range_end=row.date_range_end,
        status=row.status.value
        if isinstance(row.status, InsightStatus)
        else row.status,
        sub_status=row.sub_status,
        error_message=row.error_message,
        strategy_metadata=getattr(row, "strategy_metadata", None),
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _get_project_or_404(db: Session, project_id: int) -> Project:
    row = db.get(Project, project_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")
    return row


def _encode_sse_event(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


router = APIRouter(
    prefix="/ai-insights", tags=["ai-insights"], dependencies=[Depends(protected)]
)


@router.post("/generate", response_model=InsightStatusResponse)
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def generate_insight(
    payload: InsightGenerateRequest,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """
    Start insight generation in the background.
    Returns immediately with the insight ID. Poll /ai-insights/{id}/stream for progress.
    """
    project_service.ensure_project_access(
        db, payload.project_id, operator=x_operator, is_admin=is_admin
    )
    project = _get_project_or_404(db, payload.project_id)

    insight = AIInsight(
        project_id=payload.project_id,
        project_name=project.project_name,
        country=payload.country,
        title="生成中...",
        content="",
        insight_type=InsightType(payload.insight_type)
        if payload.insight_type in [e.value for e in InsightType]
        else InsightType.custom,
        date_range_start=payload.date_range_start,
        date_range_end=payload.date_range_end,
        status=InsightStatus.pending,
        created_by=x_operator or "unknown",
    )
    db.add(insight)
    db.commit()
    db.refresh(insight)

    celery_generate_insight.delay(None, insight_id=insight.id)

    return InsightStatusResponse(
        status="pending",
        insight_id=insight.id,
    )


@router.get("/{insight_id}/stream")
def stream_insight(
    insight_id: int,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """
    SSE stream for insight generation progress.
    Subscribe after calling POST /generate to receive real-time updates.
    Works even after navigating away from the page.
    """
    insight = db.get(AIInsight, insight_id)
    if insight is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    # Access check: non-admin users can only stream insights from projects they manage
    project_service.ensure_project_access(
        db, insight.project_id, operator=operator, is_admin=is_admin
    )

    insight_id_val = insight.id
    start_status = insight.status

    def event_generator():
        # If already completed/failed, send current state immediately and close
        if start_status in (InsightStatus.completed, InsightStatus.failed):
            yield _encode_sse_event(
                {
                    "type": "status",
                    "status": start_status.value,
                    "sub_status": None,
                    "insight_id": insight_id_val,
                    "title": insight.title or "",
                    "content": normalize_insight_markdown(insight.content or ""),
                    "error_message": insight.error_message,
                }
            )
            return

        # Celery-backed generation: poll the authoritative DB row and stream terminal state when ready.
        last_status = start_status
        for _ in range(1800):  # up to 1 hour
            time.sleep(2)
            db.refresh(insight)
            current_status = insight.status
            if current_status in (InsightStatus.completed, InsightStatus.failed):
                if current_status == InsightStatus.completed:
                    yield _encode_sse_event(
                        {
                            "type": "done",
                            "status": current_status.value,
                            "insight_id": insight_id_val,
                            "title": insight.title or "",
                            "content": normalize_insight_markdown(
                                insight.content or ""
                            ),
                            "error_message": None,
                        }
                    )
                else:
                    yield _encode_sse_event(
                        {
                            "type": "error",
                            "error": insight.error_message or "洞察生成失败",
                            "insight_id": insight_id_val,
                            "status": current_status.value,
                            "error_message": insight.error_message,
                        }
                    )
                return
            if current_status != last_status:
                last_status = current_status
                yield _encode_sse_event(
                    {
                        "type": "status",
                        "status": current_status.value,
                        "sub_status": insight.sub_status,
                        "insight_id": insight_id_val,
                    }
                )
            yield _encode_sse_event({"type": "ping"})

        yield _encode_sse_event(
            {
                "type": "error",
                "error": "洞察生成超时，请稍后查看结果",
                "insight_id": insight_id_val,
            }
        )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("", response_model=InsightListResponse)
def list_insights(
    project_id: int | None = None,
    country: str | None = None,
    status_filter: str | None = None,
    insight_type: str | None = None,
    limit: int = 20,
    offset: int = 0,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightListResponse:
    accessible_ids = project_service.list_accessible_project_ids(
        db, operator=operator, is_admin=is_admin
    )

    stmt = select(AIInsight)
    count_stmt = select(func.count(AIInsight.id))

    # Non-admin users can only see insights from projects they have access to
    if accessible_ids is not None:
        stmt = stmt.where(AIInsight.project_id.in_(accessible_ids))
        count_stmt = count_stmt.where(AIInsight.project_id.in_(accessible_ids))
        # If user has no accessible projects, return empty result
        if not accessible_ids:
            return InsightListResponse(items=[], total=0)

    if project_id is not None:
        stmt = stmt.where(AIInsight.project_id == project_id)
        count_stmt = count_stmt.where(AIInsight.project_id == project_id)
    if country is not None:
        stmt = stmt.where(AIInsight.country == country)
        count_stmt = count_stmt.where(AIInsight.country == country)
    if status_filter is not None:
        stmt = stmt.where(AIInsight.status == status_filter)
        count_stmt = count_stmt.where(AIInsight.status == status_filter)
    if insight_type is not None:
        stmt = stmt.where(AIInsight.insight_type == insight_type)
        count_stmt = count_stmt.where(AIInsight.insight_type == insight_type)

    stmt = stmt.order_by(AIInsight.created_at.desc()).limit(limit).offset(offset)
    rows = db.execute(stmt).scalars().all()
    total = db.execute(count_stmt).scalar() or 0

    return InsightListResponse(
        items=[_serialize_insight(row) for row in rows],
        total=total,
    )


@router.get("/latest")
def get_latest_insight(
    project_id: int,
    country: str = "US",
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightDetail | InsightStatusResponse:
    # Access check: non-admin users can only view latest insight from projects they manage
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=is_admin
    )

    stmt = (
        select(AIInsight)
        .where(
            AIInsight.project_id == project_id,
            AIInsight.country == country,
            AIInsight.status == InsightStatus.completed,
        )
        .order_by(AIInsight.created_at.desc())
        .limit(1)
    )
    row = db.execute(stmt).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="暂无洞察记录"
        )
    return _serialize_insight_detail(row)


# -------------------------------------------------------------------------------------------------
# Insight Schedule Endpoints (定时任务管理)
# NOTE: These MUST be defined BEFORE /{insight_id} routes to avoid path conflicts
# -------------------------------------------------------------------------------------------------


def _serialize_schedule(db: Session, schedule) -> InsightScheduleItem:
    """序列化 InsightSchedule 为响应模型"""
    project = db.get(Project, schedule.project_id)
    project_name = project.project_name if project else "未知项目"

    return InsightScheduleItem(
        id=schedule.id,
        project_id=schedule.project_id,
        project_name=project_name,
        country=schedule.country,
        insight_type=schedule.insight_type,
        cron_expression=schedule.cron_expression,
        date_range_strategy=schedule.date_range_strategy,
        model=schedule.model,
        is_active=schedule.is_active,
        run_count=schedule.run_count,
        failure_count=schedule.failure_count,
        last_run_at=schedule.last_run_at,
        last_insight_id=schedule.last_insight_id,
        last_error=schedule.last_error,
        next_run_at=schedule.next_run_at,
        created_by=schedule.created_by,
        created_at=schedule.created_at,
        updated_at=schedule.updated_at,
    )


@router.get("/schedules", response_model=InsightScheduleListResponse)
def list_schedules(
    project_id: int | None = None,
    is_active: bool | None = None,
    insight_type: str | None = None,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """
    获取定时任务列表。
    - Admin 用户看到所有任务
    - 非 Admin 用户只看自己有项目访问权限的任务
    """
    schedules = get_schedules(
        db,
        project_id=project_id,
        is_active=is_active,
        insight_type=insight_type,
    )

    # 过滤：无项目访问权限的 schedule
    if not is_admin:
        accessible_ids = project_service.list_accessible_project_ids(
            db, operator=operator, is_admin=is_admin
        )
        if accessible_ids is not None:
            schedules = [s for s in schedules if s.project_id in accessible_ids]

    return InsightScheduleListResponse(
        items=[_serialize_schedule(db, s) for s in schedules],
        total=len(schedules),
    )


@router.post(
    "/schedules",
    response_model=InsightScheduleItem,
    status_code=status.HTTP_201_CREATED,
)
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def create_insight_schedule(
    payload: InsightScheduleCreate,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """创建新的定时洞察任务"""
    # 权限校验：项目访问权限
    project_service.ensure_project_access(
        db, payload.project_id, operator=x_operator, is_admin=is_admin
    )

    schedule = create_schedule(db, payload, operator=x_operator)
    return _serialize_schedule(db, schedule)


@router.patch("/schedules/{schedule_id}", response_model=InsightScheduleItem)
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def update_insight_schedule(
    schedule_id: int,
    payload: InsightScheduleUpdate,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """更新定时任务配置"""
    ensure_schedule_access(db, schedule_id, operator=x_operator, is_admin=is_admin)
    schedule = update_schedule(db, schedule_id, payload, operator=x_operator)
    return _serialize_schedule(db, schedule)


@router.delete("/schedules/{schedule_id}")
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def delete_insight_schedule(
    schedule_id: int,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightScheduleDeleteResponse:
    """删除定时任务"""
    ensure_schedule_access(db, schedule_id, operator=x_operator, is_admin=is_admin)
    success = delete_schedule(db, schedule_id)
    return InsightScheduleDeleteResponse(deleted=success, id=schedule_id)


@router.post(
    "/schedules/{schedule_id}/toggle",
    response_model=InsightScheduleToggleResponse,
)
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def toggle_insight_schedule(
    schedule_id: int,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """启用/禁用定时任务"""
    ensure_schedule_access(db, schedule_id, operator=x_operator, is_admin=is_admin)
    schedule = toggle_schedule(db, schedule_id)
    return InsightScheduleToggleResponse(
        id=schedule.id,
        is_active=schedule.is_active,
        message="任务已启用" if schedule.is_active else "任务已禁用",
    )


@router.post(
    "/schedules/{schedule_id}/run-now",
    response_model=InsightScheduleRunNowResponse,
)
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def run_insight_schedule_now(
    schedule_id: int,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """立即执行一次定时任务（跳过调度，直接生成洞察）"""
    ensure_schedule_access(db, schedule_id, operator=x_operator, is_admin=is_admin)
    result = run_schedule_now(db, schedule_id, operator=x_operator)

    if "error" in result:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=result["error"],
        )

    return InsightScheduleRunNowResponse(
        id=result["id"],
        insight_id=result["insight_id"],
        status=result["status"],
        message=result["message"],
    )


@router.get("/{insight_id}")
def get_insight(
    insight_id: int,
    db: Session = Depends(get_read_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightDetail:
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    # Access check: non-admin users can only view insights from projects they manage
    project_service.ensure_project_access(
        db, row.project_id, operator=operator, is_admin=is_admin
    )

    return InsightDetail(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        title=row.title,
        content=row.content,
        insight_type=row.insight_type.value
        if isinstance(row.insight_type, InsightType)
        else row.insight_type,
        date_range_start=row.date_range_start,
        date_range_end=row.date_range_end,
        status=row.status.value
        if isinstance(row.status, InsightStatus)
        else row.status,
        sub_status=row.sub_status,
        error_message=row.error_message,
        strategy_metadata=getattr(row, "strategy_metadata", None),
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.put("/{insight_id}")
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def update_insight(
    insight_id: int,
    payload: InsightUpdateRequest,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightDetail:
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    project_service.ensure_project_access(
        db, row.project_id, operator=operator, is_admin=is_admin
    )

    row.content = normalize_insight_markdown(payload.content.strip())
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)

    return _serialize_insight_detail(row)


@router.post("/{insight_id}/retry", response_model=InsightRetryResponse)
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def retry_insight(
    insight_id: int,
    db: Session = Depends(get_primary_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """
    Retry a failed or stuck insight by resetting it and spawning a new background
    generation thread with the same parameters.
    """
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    # Access check: non-admin users can only retry insights from projects they manage
    project_service.ensure_project_access(
        db, row.project_id, operator=x_operator, is_admin=is_admin
    )

    if row.status == InsightStatus.completed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="已完成的洞察无法重试，请删除后重新生成",
        )

    # Reset status so the SSE stream can pick it up
    row.status = InsightStatus.pending
    row.sub_status = None
    row.error_message = None
    row.content = ""
    row.title = "生成中..."
    db.commit()

    celery_generate_insight.delay(None, insight_id=row.id)

    return InsightRetryResponse(status="pending", insight_id=row.id)


@router.delete("/{insight_id}")
@invalidate_cache_on_commit(
    domains=["ai_insight"],
    project_id_from="global",
)
def delete_insight(
    insight_id: int,
    db: Session = Depends(get_primary_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    from app.schemas.ai_insight import InsightDeleteResponse

    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    project_service.ensure_project_access(
        db, row.project_id, operator=operator, is_admin=is_admin
    )

    db.delete(row)
    db.commit()
    return InsightDeleteResponse(deleted=True, id=insight_id)


@router.get("/ad-agent/evolution-report")
def get_ad_agent_evolution_report(
    project_id: int | None = None,
    db: Session = Depends(get_read_db_session),
) -> dict[str, Any]:
    """Get ad agent evolution report for a project."""
    from app.services.ad_agent.evolution_engine import (
        get_run_history_from_db,
        evolve_dimension_weights,
        AnalysisRunMetadata,
    )

    rows = get_run_history_from_db(db, project_id=project_id, limit=100)
    runs: list[AnalysisRunMetadata] = []
    for r in rows:
        runs.append(
            AnalysisRunMetadata(
                run_id=r["run_id"],
                project_id=r["project_id"],
                dimensions_analyzed=r.get("dimensions_analyzed", []),
                dimensions_skipped=r.get("dimensions_skipped", []),
            )
        )
    report = evolve_dimension_weights(runs, None)
    return report

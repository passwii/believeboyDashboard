import json
import os
import queue
import threading
import time
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

from app.api.deps import get_db_session, get_request_is_admin, get_request_operator, protected
from app.core.config import Settings, get_settings
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
from app.services import project_service
from app.services.ai_insight_aggregator import aggregate_project_data
from app.services.ai_insight_generator import (
    generate_insight_stream,
    generate_insight_title,
    normalize_insight_markdown,
)
from app.services.digital_employee_reporter import (
    ai_insight_start,
    ai_insight_progress,
    ai_insight_complete,
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

# 数字员工 ID（AI洞察报告员工 = id=4，通过环境变量可配置）
# TODO: 生产环境 employee_id FK 问题临时 bypass，直接设为 None 跳过所有数字员工上报
_EMPLOYEE_ID: int | None = None  # int(os.environ.get("AI_INSIGHT_EMPLOYEE_ID", "4"))

router = APIRouter(prefix="/ai-insights", tags=["ai-insights"], dependencies=[Depends(protected)])


# Global registry: insight_id -> queue.Queue for streaming content
# Background thread enqueues chunks; SSE consumer dequeues them.
_insight_queues: dict[int, queue.Queue] = {}
_insight_queues_lock = threading.Lock()


def _serialize_insight(row: AIInsight) -> InsightItem:
    return InsightItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        title=row.title,
        insight_type=row.insight_type.value if isinstance(row.insight_type, InsightType) else row.insight_type,
        date_range_start=row.date_range_start,
        date_range_end=row.date_range_end,
        status=row.status.value if isinstance(row.status, InsightStatus) else row.status,
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
        insight_type=row.insight_type.value if isinstance(row.insight_type, InsightType) else row.insight_type,
        date_range_start=row.date_range_start,
        date_range_end=row.date_range_end,
        status=row.status.value if isinstance(row.status, InsightStatus) else row.status,
        sub_status=row.sub_status,
        error_message=row.error_message,
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


def _encode_ndjson_event(payload: dict) -> bytes:
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


def _enqueue_if_exists(insight_id: int, event: dict) -> None:
    """Send an event to the SSE queue for this insight, if it exists."""
    with _insight_queues_lock:
        q = _insight_queues.get(insight_id)
    if q is not None:
        try:
            q.put_nowait(event)
            logger.debug("SSE enqueue insight_id=%s event_type=%s sub_status=%s chunk_len=%s",
                         insight_id, event.get("type"), event.get("sub_status"),
                         len(event.get("delta", "")) if event.get("type") == "chunk" else "N/A")
        except queue.Full:
            logger.warning("SSE queue full for insight_id=%s, dropping event_type=%s",
                           insight_id, event.get("type"))


def _run_insight_generation(
    insight_id: int,
    settings: Settings,
    payload: dict[str, Any],
    operator: str | None,
) -> None:
    """Background thread: generates the insight and streams progress via SSE queue."""
    from app.db.session import SessionLocal

    gen_db = SessionLocal()
    q: queue.Queue | None = None

    # 注册数字员工任务
    task_id = f"ai-insight-{insight_id}"
    try:
        if _EMPLOYEE_ID is not None:
            ai_insight_start(gen_db, _EMPLOYEE_ID, insight_id, payload.get("project_name", ""))
    except Exception:
        pass  # 不阻塞核心流程

    def _report_progress(step: str, progress: int) -> None:
        try:
            if _EMPLOYEE_ID is not None:
                ai_insight_progress(gen_db, _EMPLOYEE_ID, task_id, step, progress)
        except Exception:
            pass

    def progress_callback(step: str, detail_data: dict[str, Any] | None = None) -> None:
        """Called by the aggregator as each sub-step starts. Only enqueues SSE events (no DB access)."""
        event: dict[str, Any] = {"type": "status", "status": "generating", "sub_status": step}
        if detail_data:
            event["detail"] = detail_data
        _enqueue_if_exists(insight_id, event)

    try:
        # Register the queue for SSE consumers
        with _insight_queues_lock:
            q = queue.Queue(maxsize=200)
            _insight_queues[insight_id] = q

        # Send pending event so frontend knows job is queued
        _enqueue_if_exists(insight_id, {"type": "status", "status": "pending", "sub_status": "queued", "insight_id": insight_id})
        time.sleep(0.5)

        # Mark as generating
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.status: InsightStatus.generating,
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": None})
        time.sleep(0.5)

        # Stage 1: Data aggregation (now reports granular sub-status via callback)
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.sub_status: "data_aggregating",
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": "data_aggregating"})
        time.sleep(0.5)
        _report_progress("data_aggregating", 10)

        from datetime import date as date_type
        start_date = date_type.fromisoformat(payload["start_date"])
        end_date = date_type.fromisoformat(payload["end_date"])

        aggregated = aggregate_project_data(
            gen_db,
            project_id=payload["project_id"],
            country=payload["country"],
            start_date=start_date,
            end_date=end_date,
            progress_cb=progress_callback,
        )

        if aggregated is None:
            raise RuntimeError("无法获取项目数据")
        _report_progress("data_aggregating", 40)

        data_dict = aggregated.to_dict()

        # Stage 2: AI content generation
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.sub_status: "ai_generating",
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": "ai_generating"})
        time.sleep(0.5)
        _report_progress("ai_generating", 50)

        content_chunks: list[str] = []
        chunk_count = 0
        for chunk in generate_insight_stream(
            settings,
            data_dict,
            model=payload.get("model"),
            insight_type=payload.get("insight_type", "custom"),
        ):
            if chunk:
                content_chunks.append(chunk)
                chunk_count += 1
                _enqueue_if_exists(insight_id, {"type": "chunk", "delta": chunk})
                if chunk_count % 5 == 0:
                    _report_progress("ai_generating", 50 + min(40, chunk_count // 2))

        final_content = normalize_insight_markdown("".join(content_chunks))
        _report_progress("ai_generating", 90)

        final_content = normalize_insight_markdown("".join(content_chunks))

        # Stage 3: Title generation
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.sub_status: "title_generating",
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": "title_generating"})
        time.sleep(0.5)

        title = generate_insight_title(
            settings,
            final_content,
            payload["project_name"],
            payload["start_date"],
            payload["end_date"],
        )

        # Persist content + title to DB BEFORE sending the SSE "done" event so the
        # record is always durable before the client receives it
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.title: title,
            AIInsight.content: final_content,
            AIInsight.status: InsightStatus.completed,
            AIInsight.sub_status: None,
            AIInsight.updated_at: datetime.now(timezone.utc),
        })
        gen_db.commit()

        _enqueue_if_exists(insight_id, {
            "type": "done",
            "status": "completed",
            "insight_id": insight_id,
            "title": title,
            "content": final_content,
            "error_message": None,
        })
        try:
            if _EMPLOYEE_ID is not None:
                ai_insight_complete(gen_db, _EMPLOYEE_ID, task_id, success=True)
        except Exception:
            pass

    except Exception as exc:
        try:
            gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
                AIInsight.status: InsightStatus.failed,
                AIInsight.sub_status: None,
                AIInsight.error_message: str(exc),
            })
            gen_db.commit()
        except Exception:
            pass
        _enqueue_if_exists(insight_id, {"type": "error", "error": str(exc), "insight_id": insight_id, "status": "failed", "error_message": str(exc)})
        try:
            if _EMPLOYEE_ID is not None:
                ai_insight_complete(gen_db, _EMPLOYEE_ID, task_id, success=False, error=str(exc))
        except Exception:
            pass

    finally:
        with _insight_queues_lock:
            _insight_queues.pop(insight_id, None)
        gen_db.close()


@router.post("/generate", response_model=InsightStatusResponse)
def generate_insight(
    payload: InsightGenerateRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """
    Start insight generation in the background.
    Returns immediately with the insight ID. Poll /ai-insights/{id}/stream for progress.
    """
    project_service.ensure_project_access(db, payload.project_id, operator=x_operator, is_admin=is_admin)
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

    # Spawn background thread to do the actual work
    bg_payload = {
        "project_id": payload.project_id,
        "project_name": project.project_name,
        "country": payload.country,
        "start_date": payload.date_range_start.isoformat(),
        "end_date": payload.date_range_end.isoformat(),
        "model": payload.model,
        "insight_type": payload.insight_type,
    }
    thread = threading.Thread(
        target=_run_insight_generation,
        args=(insight.id, settings, bg_payload, x_operator),
        daemon=True,
        name=f"ai-insight-{insight.id}",
    )
    thread.start()

    return InsightStatusResponse(
        status="pending",
        insight_id=insight.id,
    )


@router.get("/{insight_id}/stream")
def stream_insight(
    insight_id: int,
    db: Session = Depends(get_db_session),
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
    project_service.ensure_project_access(db, insight.project_id, operator=operator, is_admin=is_admin)

    insight_id_val = insight.id
    start_status = insight.status
    start_created_at = insight.created_at.isoformat() if insight.created_at else ""

    def event_generator():
        # If already completed/failed, send current state immediately and close
        if start_status in (InsightStatus.completed, InsightStatus.failed):
            yield _encode_sse_event({
                "type": "status",
                "status": start_status.value,
                "sub_status": None,
                "insight_id": insight_id_val,
                "title": insight.title or "",
                "content": normalize_insight_markdown(insight.content or ""),
                "error_message": insight.error_message,
            })
            return

        # If pending, send queued state immediately and wait for the background thread
        if start_status == InsightStatus.pending:
            yield _encode_sse_event({
                "type": "status",
                "status": "pending",
                "sub_status": "queued",
                "insight_id": insight_id_val,
            })

        # Get or create queue for this insight
        with _insight_queues_lock:
            q = _insight_queues.get(insight_id_val)

        if q is None:
            # Status is pending but queue not registered yet — wait for it briefly
            for _ in range(20):  # ~2 seconds
                time.sleep(0.1)
                with _insight_queues_lock:
                    q = _insight_queues.get(insight_id_val)
                if q is not None:
                    break

        if q is None:
            yield _encode_sse_event({
                "type": "error",
                "error": "无法连接到生成任务",
                "insight_id": insight_id_val,
            })
            return

        last_event: dict | None = None
        while True:
            try:
                event = q.get(timeout=60)
                last_event = event
                event_type = event.get("type", "?")
                event_sub = event.get("sub_status", "")
                chunk_len = len(event.get("delta", "")) if event_type == "chunk" else 0
                logger.debug(
                    "SSE yield insight_id=%s type=%s sub=%s chunk_len=%s",
                    insight_id_val, event_type, event_sub, chunk_len,
                )
                yield _encode_sse_event(event)

                if event.get("type") in ("done", "error"):
                    break
            except queue.Empty:
                # Send keepalive
                yield _encode_sse_event({"type": "ping"})
                continue

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# Legacy streaming endpoint kept for backwards compatibility during transition
@router.post("/generate/stream")
def generate_insight_stream_endpoint(
    payload: InsightGenerateRequest,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """
    Legacy endpoint: generates insight in the request thread with streaming response.
    Prefer POST /generate + GET /{id}/stream for background execution.
    """
    project_service.ensure_project_access(db, payload.project_id, operator=operator, is_admin=is_admin)
    project = _get_project_or_404(db, payload.project_id)
    project_name = project.project_name
    start_date_str = payload.date_range_start.isoformat()
    end_date_str = payload.date_range_end.isoformat()

    insight = AIInsight(
        project_id=payload.project_id,
        project_name=project_name,
        country=payload.country,
        title="生成中...",
        content="",
        insight_type=InsightType(payload.insight_type)
        if payload.insight_type in [e.value for e in InsightType]
        else InsightType.custom,
        date_range_start=payload.date_range_start,
        date_range_end=payload.date_range_end,
        status=InsightStatus.generating,
        created_by=operator or "unknown",
    )
    db.add(insight)
    db.commit()
    db.refresh(insight)

    insight_id = insight.id

    def event_stream():
        from app.db.session import SessionLocal
        gen_db = SessionLocal()
        try:
            yield _encode_ndjson_event({"type": "status", "status": "generating", "sub_status": "data_aggregating", "insight_id": insight_id})

            aggregated = aggregate_project_data(
                gen_db,
                project_id=payload.project_id,
                country=payload.country,
                start_date=payload.date_range_start,
                end_date=payload.date_range_end,
            )

            if aggregated is None:
                raise RuntimeError("无法获取项目数据")

            data_dict = aggregated.to_dict()

            yield _encode_ndjson_event({"type": "status", "status": "generating", "sub_status": "ai_generating", "insight_id": insight_id})

            content_chunks: list[str] = []
            for chunk in generate_insight_stream(
                settings,
                data_dict,
                model=payload.model,
                insight_type=payload.insight_type,
            ):
                if chunk:
                    content_chunks.append(chunk)
                    yield _encode_ndjson_event({"type": "chunk", "delta": chunk})

            final_content = "".join(content_chunks)

            yield _encode_ndjson_event({"type": "status", "status": "generating", "sub_status": "title_generating", "insight_id": insight_id})

            title = generate_insight_title(
                settings,
                final_content,
                project_name,
                start_date_str,
                end_date_str,
            )

            gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
                AIInsight.title: title,
                AIInsight.content: final_content,
                AIInsight.status: InsightStatus.completed,
                AIInsight.sub_status: None,
                AIInsight.updated_at: datetime.now(timezone.utc),
            })
            gen_db.commit()

            yield _encode_ndjson_event({
                "type": "done",
                "insight_id": insight_id,
                "title": title,
                "content": final_content,
            })

        except Exception as exc:
            try:
                gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
                    AIInsight.status: InsightStatus.failed,
                    AIInsight.sub_status: None,
                    AIInsight.error_message: str(exc),
                })
                gen_db.commit()
            except Exception:
                pass
            yield _encode_ndjson_event({
                "type": "error",
                "error": str(exc),
                "insight_id": insight_id,
            })
        finally:
            gen_db.close()

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
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
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightListResponse:
    accessible_ids = project_service.list_accessible_project_ids(db, operator=operator, is_admin=is_admin)

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
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightDetail | InsightStatusResponse:
    # Access check: non-admin users can only view latest insight from projects they manage
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=is_admin)

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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="暂无洞察记录")
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
    db: Session = Depends(get_db_session),
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
        from app.services import project_service

        accessible_ids = project_service.list_accessible_project_ids(
            db, operator=operator, is_admin=is_admin
        )
        if accessible_ids is not None:
            schedules = [
                s for s in schedules if s.project_id in accessible_ids
            ]

    return InsightScheduleListResponse(
        items=[_serialize_schedule(db, s) for s in schedules],
        total=len(schedules),
    )


@router.post(
    "/schedules",
    response_model=InsightScheduleItem,
    status_code=status.HTTP_201_CREATED,
)
def create_insight_schedule(
    payload: InsightScheduleCreate,
    db: Session = Depends(get_db_session),
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
def update_insight_schedule(
    schedule_id: int,
    payload: InsightScheduleUpdate,
    db: Session = Depends(get_db_session),
    x_operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    """更新定时任务配置"""
    ensure_schedule_access(db, schedule_id, operator=x_operator, is_admin=is_admin)
    schedule = update_schedule(db, schedule_id, payload, operator=x_operator)
    return _serialize_schedule(db, schedule)


@router.delete("/schedules/{schedule_id}")
def delete_insight_schedule(
    schedule_id: int,
    db: Session = Depends(get_db_session),
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
def toggle_insight_schedule(
    schedule_id: int,
    db: Session = Depends(get_db_session),
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
def run_insight_schedule_now(
    schedule_id: int,
    db: Session = Depends(get_db_session),
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
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightDetail:
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    # Access check: non-admin users can only view insights from projects they manage
    project_service.ensure_project_access(db, row.project_id, operator=operator, is_admin=is_admin)

    return InsightDetail(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        title=row.title,
        content=row.content,
        insight_type=row.insight_type.value if isinstance(row.insight_type, InsightType) else row.insight_type,
        date_range_start=row.date_range_start,
        date_range_end=row.date_range_end,
        status=row.status.value if isinstance(row.status, InsightStatus) else row.status,
        sub_status=row.sub_status,
        error_message=row.error_message,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.put("/{insight_id}")
def update_insight(
    insight_id: int,
    payload: InsightUpdateRequest,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
) -> InsightDetail:
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    project_service.ensure_project_access(db, row.project_id, operator=operator, is_admin=is_admin)

    row.content = normalize_insight_markdown(payload.content.strip())
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)

    return _serialize_insight_detail(row)


@router.post("/{insight_id}/retry", response_model=InsightRetryResponse)
def retry_insight(
    insight_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
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
    project_service.ensure_project_access(db, row.project_id, operator=x_operator, is_admin=is_admin)

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

    bg_payload = {
        "project_id": row.project_id,
        "project_name": row.project_name,
        "country": row.country,
        "start_date": row.date_range_start.isoformat(),
        "end_date": row.date_range_end.isoformat(),
        "model": None,  # model is not persisted; use default
        "insight_type": row.insight_type.value if isinstance(row.insight_type, InsightType) else str(row.insight_type or "custom"),
    }
    thread = threading.Thread(
        target=_run_insight_generation,
        args=(row.id, settings, bg_payload, x_operator),
        daemon=True,
        name=f"ai-insight-retry-{row.id}",
    )
    thread.start()

    return InsightRetryResponse(status="pending", insight_id=row.id)


@router.delete("/{insight_id}")
def delete_insight(
    insight_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Depends(get_request_is_admin),
):
    from app.schemas.ai_insight import InsightDeleteResponse
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

    project_service.ensure_project_access(db, row.project_id, operator=operator, is_admin=is_admin)

    db.delete(row)
    db.commit()
    return InsightDeleteResponse(deleted=True, id=insight_id)

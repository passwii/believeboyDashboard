import json
import queue
import threading
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.core.config import Settings, get_settings
from app.models import AIInsight, InsightStatus, InsightType, Project
from app.schemas.ai_insight import (
    InsightChunkResponse,
    InsightDetail,
    InsightDoneResponse,
    InsightGenerateRequest,
    InsightItem,
    InsightListResponse,
    InsightStatusResponse,
)
from app.services import ai_chat_service
from app.services.ai_insight_aggregator import aggregate_project_data
from app.services.ai_insight_generator import (
    generate_insight_stream,
    generate_insight_title,
)

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
    return (json.dumps(payload, ensure_ascii=False) + "\n\n").encode("utf-8")


def _enqueue_if_exists(insight_id: int, event: dict) -> None:
    """Send an event to the SSE queue for this insight, if it exists."""
    with _insight_queues_lock:
        q = _insight_queues.get(insight_id)
    if q is not None:
        try:
            q.put_nowait(event)
        except queue.Full:
            pass


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

    def progress_callback(step: str) -> None:
        """Called by the aggregator as each sub-step starts. Only enqueues SSE events (no DB access)."""
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": step})

    try:
        # Register the queue for SSE consumers
        with _insight_queues_lock:
            q = queue.Queue(maxsize=200)
            _insight_queues[insight_id] = q

        # Mark as generating
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.status: InsightStatus.generating,
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": None})

        # Stage 1: Data aggregation (now reports granular sub-status via callback)
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.sub_status: "data_aggregating",
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": "data_aggregating"})

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

        data_dict = aggregated.to_dict()

        # Stage 2: AI content generation
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.sub_status: "ai_generating",
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": "ai_generating"})

        content_chunks: list[str] = []
        for chunk in generate_insight_stream(settings, data_dict):
            if chunk:
                content_chunks.append(chunk)
                _enqueue_if_exists(insight_id, {"type": "chunk", "delta": chunk})

        final_content = "".join(content_chunks)

        # Stage 3: Title generation
        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update({
            AIInsight.sub_status: "title_generating",
        })
        gen_db.commit()
        _enqueue_if_exists(insight_id, {"type": "status", "status": "generating", "sub_status": "title_generating"})

        title = generate_insight_title(
            settings,
            final_content,
            payload["project_name"],
            payload["start_date"],
            payload["end_date"],
        )

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
        _enqueue_if_exists(insight_id, {"type": "error", "error": str(exc), "insight_id": insight_id})

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
):
    """
    Start insight generation in the background.
    Returns immediately with the insight ID. Poll /ai-insights/{id}/stream for progress.
    """
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
):
    """
    SSE stream for insight generation progress.
    Subscribe after calling POST /generate to receive real-time updates.
    Works even after navigating away from the page.
    """
    insight = db.get(AIInsight, insight_id)
    if insight is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")

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
                "content": insight.content or "",
            })
            return

        # Get or create queue for this insight
        with _insight_queues_lock:
            q = _insight_queues.get(insight_id_val)

        if q is None:
            # Status is pending but queue not registered yet — wait for it briefly
            import time
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
):
    """
    Legacy endpoint: generates insight in the request thread with streaming response.
    Prefer POST /generate + GET /{id}/stream for background execution.
    """
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
            yield _encode_sse_event({"type": "status", "status": "generating", "sub_status": "data_aggregating", "insight_id": insight_id})

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

            yield _encode_sse_event({"type": "status", "status": "generating", "sub_status": "ai_generating", "insight_id": insight_id})

            content_chunks: list[str] = []
            for chunk in generate_insight_stream(settings, data_dict):
                if chunk:
                    content_chunks.append(chunk)
                    yield _encode_sse_event({"type": "chunk", "delta": chunk})

            final_content = "".join(content_chunks)

            yield _encode_sse_event({"type": "status", "status": "generating", "sub_status": "title_generating", "insight_id": insight_id})

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

            yield _encode_sse_event({
                "type": "done",
                "insight_id": insight_id,
                "title": title,
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
            yield _encode_sse_event({
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
    limit: int = 20,
    offset: int = 0,
    db: Session = Depends(get_db_session),
) -> InsightListResponse:
    stmt = select(AIInsight)
    count_stmt = select(func.count(AIInsight.id))

    if project_id is not None:
        stmt = stmt.where(AIInsight.project_id == project_id)
        count_stmt = count_stmt.where(AIInsight.project_id == project_id)
    if country is not None:
        stmt = stmt.where(AIInsight.country == country)
        count_stmt = count_stmt.where(AIInsight.country == country)
    if status_filter is not None:
        stmt = stmt.where(AIInsight.status == status_filter)
        count_stmt = count_stmt.where(AIInsight.status == status_filter)

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
) -> InsightDetail | InsightStatusResponse:
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
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/{insight_id}")
def get_insight(
    insight_id: int,
    db: Session = Depends(get_db_session),
) -> InsightDetail:
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")
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
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.delete("/{insight_id}")
def delete_insight(
    insight_id: int,
    db: Session = Depends(get_db_session),
):
    from app.schemas.ai_insight import InsightDeleteResponse
    row = db.get(AIInsight, insight_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="洞察不存在")
    db.delete(row)
    db.commit()
    return InsightDeleteResponse(deleted=True, id=insight_id)

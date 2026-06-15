"""Runtime service for AI insight generation."""

from __future__ import annotations

import json
import logging
from datetime import date as date_type
from datetime import datetime, timezone
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import AIInsight, InsightStatus

logger = logging.getLogger(__name__)

_EMPLOYEE_ID: int | None = None

EventCallback = Callable[[dict[str, Any]], None]


def _emit_event(
    insight_id: int,
    event: dict[str, Any],
    enqueue_event: EventCallback | None,
) -> None:
    if enqueue_event is not None:
        enqueue_event(event)
    else:
        logger.debug(
            "Insight runtime event insight_id=%s type=%s sub_status=%s",
            insight_id,
            event.get("type"),
            event.get("sub_status"),
        )


def run_insight_generation(
    insight_id: int,
    settings: Settings,
    payload: dict[str, Any],
    operator: str | None,
    enqueue_event: EventCallback | None = None,
) -> bool:
    """Generate an AIInsight row identified by `insight_id`.

    The Celery task passes only ids and lets this service load project/schedule
    data from the database. The legacy in-process API path can still pass an
    SSE enqueue callback for streaming compatibility.
    """
    from app.db.session import SessionLocal
    from app.services.ai_insight_aggregator import aggregate_project_data
    from app.services.ai_insight_generator import (
        generate_insight_stream,
        generate_insight_title,
        normalize_insight_markdown,
    )
    from app.services.ai_insight_utils import (
        format_project_context_for_prompt,
        format_sku_context_for_prompt,
    )
    from app.services.digital_employee_reporter import (
        ai_insight_start,
        ai_insight_progress,
        ai_insight_complete,
    )

    gen_db: Session = SessionLocal()
    task_id = f"ai-insight-{insight_id}"

    try:
        if _EMPLOYEE_ID is not None:
            ai_insight_start(gen_db, _EMPLOYEE_ID, insight_id, payload.get("project_name", ""))
    except Exception:
        pass

    def _report_progress(step: str, progress: int) -> None:
        try:
            if _EMPLOYEE_ID is not None:
                ai_insight_progress(gen_db, _EMPLOYEE_ID, task_id, step, progress)
        except Exception:
            pass

    def progress_callback(step: str, detail_data: dict[str, Any] | None = None) -> None:
        _emit_event(
            insight_id,
            {"type": "status", "status": "generating", "sub_status": step, "detail": detail_data}
            if detail_data
            else {"type": "status", "status": "generating", "sub_status": step},
            enqueue_event,
        )

    try:
        _emit_event(
            insight_id,
            {
                "type": "status",
                "status": "pending",
                "sub_status": "queued",
                "insight_id": insight_id,
            },
            enqueue_event,
        )

        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update(
            {AIInsight.status: InsightStatus.generating}
        )
        gen_db.commit()
        _emit_event(
            insight_id,
            {"type": "status", "status": "generating", "sub_status": None},
            enqueue_event,
        )

        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update(
            {AIInsight.sub_status: "data_aggregating"}
        )
        gen_db.commit()
        _emit_event(
            insight_id,
            {"type": "status", "status": "generating", "sub_status": "data_aggregating"},
            enqueue_event,
        )
        _report_progress("data_aggregating", 10)

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

        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update(
            {AIInsight.sub_status: "ai_generating"}
        )
        gen_db.commit()
        _emit_event(
            insight_id,
            {"type": "status", "status": "generating", "sub_status": "ai_generating"},
            enqueue_event,
        )
        _report_progress("ai_generating", 50)

        content_chunks: list[str] = []
        chunk_count = 0
        strategy_metadata_str: str | None = None

        if payload.get("insight_type") == "ad_analysis":
            from app.services.ad_agent.pipeline import run_ad_agent_pipeline_multi_pass_stream

            project_context_text = format_project_context_for_prompt(
                data_dict.get("project_context") or {}
            )
            sku_context_text = format_sku_context_for_prompt(
                data_dict.get("sku_context") or {}
            )

            for event in run_ad_agent_pipeline_multi_pass_stream(
                aggregated_data=data_dict,
                settings=settings,
                project_id=payload["project_id"],
                project_name=payload["project_name"],
                country=payload["country"],
                date_range_start=payload["start_date"],
                date_range_end=payload["end_date"],
                project_context_text=project_context_text,
                sku_context_text=sku_context_text,
                model=payload.get("model"),
                db=gen_db,
                insight_id=insight_id,
            ):
                etype = event.get("type")
                if etype == "chunk":
                    delta = event.get("delta", "")
                    if delta:
                        content_chunks.append(delta)
                        chunk_count += 1
                        _emit_event(insight_id, {"type": "chunk", "delta": delta}, enqueue_event)
                        if chunk_count % 5 == 0:
                            _report_progress("ai_generating", 50 + min(40, chunk_count // 2))
                elif etype == "profile":
                    _emit_event(
                        insight_id,
                        {"type": "status", "status": "generating", "sub_status": "agent_profiling"},
                        enqueue_event,
                    )
                    _emit_event(
                        insight_id,
                        {"type": "agent_stage", "stage": "profile", "data": event.get("data")},
                        enqueue_event,
                    )
                elif etype == "strategy":
                    _emit_event(
                        insight_id,
                        {"type": "status", "status": "generating", "sub_status": "agent_planning"},
                        enqueue_event,
                    )
                    _emit_event(
                        insight_id,
                        {"type": "agent_stage", "stage": "strategy", "data": event.get("data")},
                        enqueue_event,
                    )
                elif etype == "declaration":
                    _emit_event(
                        insight_id,
                        {
                            "type": "agent_stage",
                            "stage": "declaration",
                            "text": event.get("text", ""),
                        },
                        enqueue_event,
                    )
                elif etype == "pass_mode":
                    mode_label = "多轮分析" if event.get("mode") == "multi_pass" else "单轮分析"
                    _emit_event(
                        insight_id,
                        {
                            "type": "agent_stage",
                            "stage": "pass_mode",
                            "text": mode_label,
                        },
                        enqueue_event,
                    )
                elif etype == "pass":
                    _emit_event(
                        insight_id,
                        {
                            "type": "agent_stage",
                            "stage": f"pass_{event.get('pass', 0)}",
                            "data": {"name": event.get("name", ""), "status": event.get("status", "")},
                        },
                        enqueue_event,
                    )
                elif etype == "hotspots":
                    _emit_event(
                        insight_id,
                        {
                            "type": "agent_stage",
                            "stage": "hotspots",
                            "data": event.get("data"),
                        },
                        enqueue_event,
                    )
                elif etype == "done":
                    pipeline_content = event.get("content", "")
                    if pipeline_content:
                        content_chunks = [pipeline_content]
                    strategy_metadata_str = json.dumps(
                        {
                            "strategy_declaration": event.get("strategy_declaration", ""),
                            "evolution_metadata": event.get("evolution_metadata", {}),
                        },
                        ensure_ascii=False,
                    )
        else:
            for chunk in generate_insight_stream(
                settings,
                data_dict,
                model=payload.get("model"),
                insight_type=payload.get("insight_type", "custom"),
            ):
                if chunk:
                    content_chunks.append(chunk)
                    chunk_count += 1
                    _emit_event(insight_id, {"type": "chunk", "delta": chunk}, enqueue_event)
                    if chunk_count % 5 == 0:
                        _report_progress("ai_generating", 50 + min(40, chunk_count // 2))

        final_content = normalize_insight_markdown("".join(content_chunks))
        _report_progress("ai_generating", 90)

        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update(
            {AIInsight.sub_status: "title_generating"}
        )
        gen_db.commit()
        _emit_event(
            insight_id,
            {"type": "status", "status": "generating", "sub_status": "title_generating"},
            enqueue_event,
        )

        title = generate_insight_title(
            settings,
            final_content,
            payload["project_name"],
            payload["start_date"],
            payload["end_date"],
        )

        gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update(
            {
                AIInsight.title: title,
                AIInsight.content: final_content,
                AIInsight.strategy_metadata: strategy_metadata_str,
                AIInsight.status: InsightStatus.completed,
                AIInsight.sub_status: None,
                AIInsight.updated_at: datetime.now(timezone.utc),
            }
        )
        gen_db.commit()

        _emit_event(
            insight_id,
            {
                "type": "done",
                "status": "completed",
                "insight_id": insight_id,
                "title": title,
                "content": final_content,
                "error_message": None,
            },
            enqueue_event,
        )
        try:
            if _EMPLOYEE_ID is not None:
                ai_insight_complete(gen_db, _EMPLOYEE_ID, task_id, success=True)
        except Exception:
            pass
        return True

    except Exception as exc:
        try:
            gen_db.query(AIInsight).filter(AIInsight.id == insight_id).update(
                {
                    AIInsight.status: InsightStatus.failed,
                    AIInsight.sub_status: None,
                    AIInsight.error_message: str(exc),
                }
            )
            gen_db.commit()
        except Exception:
            pass
        _emit_event(
            insight_id,
            {
                "type": "error",
                "error": str(exc),
                "insight_id": insight_id,
                "status": "failed",
                "error_message": str(exc),
            },
            enqueue_event,
        )
        try:
            if _EMPLOYEE_ID is not None:
                ai_insight_complete(gen_db, _EMPLOYEE_ID, task_id, success=False, error=str(exc))
        except Exception:
            pass
        return False

    finally:
        gen_db.close()

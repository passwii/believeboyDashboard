"""Celery task that generates scheduled AI insights."""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

from celery import shared_task

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.infra.cache_decorator import mark_committed
from app.models import AIInsight, InsightSchedule, InsightStatus, InsightType, Project
from app.services.ai_insight_runtime_service import run_insight_generation
from app.services.insight.domain_switch import legacy_write_frozen
from app.services.insight_concurrency import acquire_remote_semaphore

logger = logging.getLogger(__name__)

TASK_NAME = "generate_insight"


@shared_task(
    name=TASK_NAME,
    bind=True,
    acks_late=True,
    max_retries=2,
    time_limit=600,
)
def generate_insight(
    self,
    schedule_id: int | None = None,
    insight_id: int | None = None,
) -> dict:
    """Generate an AI insight from schedule state stored in the database."""
    settings = get_settings()
    db = SessionLocal()
    schedule = None
    created_insight_id: int | None = None

    try:
        if schedule_id is None and insight_id is None:
            raise ValueError("schedule_id or insight_id is required")

        if schedule_id is not None:
            schedule = db.get(InsightSchedule, schedule_id)
            if schedule is None:
                logger.warning("generate_insight: schedule %s not found", schedule_id)
                return {"status": "missing", "schedule_id": schedule_id}
            if not schedule.is_active:
                logger.warning("generate_insight: schedule %s is inactive", schedule_id)
                return {"status": "inactive", "schedule_id": schedule_id}

        if insight_id is None:
            if schedule is None:
                raise ValueError("schedule is required when insight_id is omitted")

            # 已切 canonical 的域不再自动建旧 AIInsight 行（BLF-1016）。此处是
            # 调度链的最后一个旧写点；显式 insight_id 的在途行不拦。
            frozen_role = legacy_write_frozen(settings, schedule.insight_type)
            if frozen_role:
                logger.info(
                    "generate_insight: domain '%s' migrated to canonical Insight; "
                    "skipping legacy row creation for schedule %s",
                    frozen_role,
                    schedule.id,
                )
                return {
                    "status": "domain_migrated",
                    "domain": frozen_role,
                    "schedule_id": schedule_id,
                }

            project = db.get(Project, schedule.project_id)
            if project is None:
                logger.error(
                    "generate_insight: project %s not found", schedule.project_id
                )
                return {"status": "missing_project", "schedule_id": schedule_id}

            start_date, end_date = _calculate_date_range(schedule.date_range_strategy)
            insight = AIInsight(
                project_id=schedule.project_id,
                project_name=project.project_name,
                country=schedule.country,
                title="定时生成中...",
                content="",
                insight_type=InsightType(schedule.insight_type),
                date_range_start=start_date,
                date_range_end=end_date,
                status=InsightStatus.pending,
                created_by=f"scheduler:{schedule.id}",
            )
            db.add(insight)
            db.commit()
            mark_committed()  # BLF-669: commit 后必须 mark
            db.refresh(insight)
            created_insight_id = insight.id

            schedule.last_run_at = datetime.now(timezone.utc)
            schedule.last_insight_id = insight.id
            schedule.run_count += 1
            schedule.last_error = None
            db.commit()
            mark_committed()  # BLF-669: commit 后必须 mark
        else:
            insight = db.get(AIInsight, insight_id)
            if insight is None:
                logger.warning("generate_insight: insight %s not found", insight_id)
                return {"status": "missing", "insight_id": insight_id}
            created_insight_id = insight.id
            if schedule is not None:
                schedule.last_insight_id = insight.id
                db.commit()
                mark_committed()  # BLF-669: commit 后必须 mark

        payload = {
            "project_id": insight.project_id,
            "project_name": insight.project_name,
            "country": insight.country,
            "start_date": insight.date_range_start.isoformat(),
            "end_date": insight.date_range_end.isoformat(),
            "model": schedule.model if schedule is not None else None,
            "insight_type": insight.insight_type.value
            if isinstance(insight.insight_type, InsightType)
            else str(insight.insight_type),
        }
    except Exception as exc:
        db.rollback()
        logger.exception("generate_insight: failed to prepare insight payload: %s", exc)
        if schedule_id is not None:
            _update_schedule_failure(db, schedule_id, str(exc))
        return {
            "status": "failed",
            "schedule_id": schedule_id,
            "insight_id": insight_id,
            "error": str(exc),
        }
    finally:
        db.close()

    try:
        with acquire_remote_semaphore("insights", timeout=300) as acquired:
            if not acquired:
                _update_insight_failure(
                    created_insight_id, "Could not acquire insight semaphore"
                )
                if schedule_id is not None:
                    _update_schedule_failure(
                        SessionLocal(),
                        schedule_id,
                        "Could not acquire insight semaphore",
                    )
                return {
                    "status": "semaphore_timeout",
                    "schedule_id": schedule_id,
                    "insight_id": created_insight_id,
                }

            ok = run_insight_generation(
                insight_id=created_insight_id,
                settings=settings,
                payload=payload,
                operator=f"scheduler:{schedule_id}"
                if schedule_id is not None
                else "celery",
            )
    except Exception as exc:
        logger.exception(
            "generate_insight: insight %s generation failed", created_insight_id
        )
        _update_insight_failure(created_insight_id, str(exc))
        if schedule_id is not None:
            _update_schedule_failure(SessionLocal(), schedule_id, str(exc))
        return {
            "status": "failed",
            "schedule_id": schedule_id,
            "insight_id": created_insight_id,
            "error": str(exc),
        }

    if not ok:
        _update_insight_failure(created_insight_id, "Insight generation failed")
        if schedule_id is not None:
            _update_schedule_failure(
                SessionLocal(), schedule_id, "Insight generation failed"
            )
        return {
            "status": "failed",
            "schedule_id": schedule_id,
            "insight_id": created_insight_id,
        }

    return {
        "status": "completed",
        "schedule_id": schedule_id,
        "insight_id": created_insight_id,
    }


def _calculate_date_range(strategy: str) -> tuple[date, date]:
    reference_date = date.today()
    yesterday = reference_date - timedelta(days=1)

    if strategy == "yesterday":
        return yesterday, yesterday
    if strategy == "last_7d":
        return reference_date - timedelta(days=7), yesterday
    if strategy == "last_30d":
        return reference_date - timedelta(days=30), yesterday
    if strategy == "prev_month":
        first_of_month = date(reference_date.year, reference_date.month, 1)
        prev_month_end = first_of_month - timedelta(days=1)
        return date(prev_month_end.year, prev_month_end.month, 1), prev_month_end
    if strategy == "current_month":
        return date(reference_date.year, reference_date.month, 1), yesterday
    if strategy == "last_week":
        days_since_monday = reference_date.weekday()
        last_monday = reference_date - timedelta(days_since_monday + 7)
        return last_monday, last_monday + timedelta(days=6)

    logger.warning(
        "Unknown date_range_strategy '%s', defaulting to yesterday", strategy
    )
    return yesterday, yesterday


def _update_insight_failure(insight_id: int | None, error_message: str) -> None:
    if insight_id is None:
        return

    db = SessionLocal()
    try:
        insight = db.get(AIInsight, insight_id)
        if insight is not None:
            insight.status = InsightStatus.failed
            insight.sub_status = None
            insight.error_message = error_message[:2000]
            db.commit()
            mark_committed()  # BLF-669: commit 后必须 mark
    except Exception:
        db.rollback()
    finally:
        db.close()


def _update_schedule_failure(db, schedule_id: int, error_message: str) -> None:
    try:
        schedule = db.get(InsightSchedule, schedule_id)
        if schedule is not None:
            schedule.failure_count += 1
            schedule.last_error = error_message[:500]
            db.commit()
            mark_committed()  # BLF-669: commit 后必须 mark
    except Exception:
        db.rollback()
    finally:
        db.close()

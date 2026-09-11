"""
Insight Schedule Service — 定时任务 CRUD + 调度触发逻辑

核心职责：
1. CRUD 操作：创建、更新、删除、切换启用状态
2. APScheduler Job 注册/移除
3. 调度触发时执行洞察生成
4. 并发控制（Semaphore）
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select, func
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import InsightSchedule, Project, AIInsight, InsightStatus, InsightType
from app.celery_tasks.insights.generate import generate_insight
from app.services.insight.domain_switch import domain_switch_error, legacy_write_frozen
from app.services.insight_concurrency import acquire_remote_semaphore

if TYPE_CHECKING:
    from app.core.config import Settings

logger = logging.getLogger(__name__)
MAX_CONCURRENT_INSIGHTS = 3


def _get_scheduler():
    """获取全局调度器实例（延迟导入避免循环依赖）"""
    from app.core.scheduler import get_scheduler

    return get_scheduler()


# -------------------------------------------------------------------------------------------------
# 权限校验
# -------------------------------------------------------------------------------------------------

def ensure_schedule_access(
    db: Session, schedule_id: int, operator: str, is_admin: bool
) -> InsightSchedule:
    """
    校验用户对 schedule 的访问权限。
    - Admin 可以访问所有任务
    - 非 Admin 用户只能访问自己有项目访问权限的任务
    """
    from app.services import project_service

    schedule = db.get(InsightSchedule, schedule_id)
    if not schedule:
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="定时任务不存在",
        )

    project_service.ensure_project_access(
        db, schedule.project_id, operator=operator, is_admin=is_admin
    )
    return schedule


# -------------------------------------------------------------------------------------------------
# 日期范围计算
# -------------------------------------------------------------------------------------------------

def calculate_date_range(
    strategy: str, reference_date: date | None = None
) -> tuple[date, date]:
    """
    根据策略和参考日期计算洞察的数据日期范围。

    Args:
        strategy: 日期范围策略 (yesterday / last_7d / last_30d / prev_month / current_month / last_week)
        reference_date: 参考日期，默认为今天

    Returns:
        (start_date, end_date) 元组
    """
    if reference_date is None:
        reference_date = date.today()

    yesterday = reference_date - timedelta(days=1)

    if strategy == "yesterday":
        return yesterday, yesterday

    elif strategy == "last_7d":
        return reference_date - timedelta(days=7), yesterday

    elif strategy == "last_30d":
        return reference_date - timedelta(days=30), yesterday

    elif strategy == "prev_month":
        # 上月1日 ~ 上月末
        first_of_month = date(reference_date.year, reference_date.month, 1)
        prev_month_end = first_of_month - timedelta(days=1)
        prev_month_start = date(prev_month_end.year, prev_month_end.month, 1)
        return prev_month_start, prev_month_end

    elif strategy == "current_month":
        first_of_month = date(reference_date.year, reference_date.month, 1)
        return first_of_month, yesterday

    elif strategy == "last_week":
        # 上周一到上周日
        days_since_monday = reference_date.weekday()  # 0=Monday
        last_monday = reference_date - timedelta(days_since_monday + 7)
        last_sunday = last_monday + timedelta(days=6)
        return last_monday, last_sunday

    else:
        # 默认返回昨天
        logger.warning(
            f"Unknown date_range_strategy '{strategy}', defaulting to yesterday"
        )
        return yesterday, yesterday


# -------------------------------------------------------------------------------------------------
# APScheduler Job 管理
# -------------------------------------------------------------------------------------------------

def _get_job_id(schedule_id: int) -> str:
    return f"insight_schedule_{schedule_id}"


def _register_job(schedule: InsightSchedule) -> None:
    """将 schedule 注册为 APScheduler Job"""
    scheduler = _get_scheduler()
    if scheduler is None:
        logger.warning("Scheduler not initialized, cannot register job")
        return

    from apscheduler.triggers.cron import CronTrigger

    # 解析 cron 表达式
    parts = schedule.cron_expression.split()
    if len(parts) != 5:
        logger.error(
            f"Invalid cron expression for schedule {schedule.id}: {schedule.cron_expression}"
        )
        return

    minute, hour, day, month, day_of_week = parts

    try:
        trigger = CronTrigger(
            minute=minute,
            hour=hour,
            day=day,
            month=month,
            day_of_week=day_of_week,
            timezone="Asia/Shanghai",
        )

        scheduler.add_job(
            run_scheduled_insight,
            trigger=trigger,
            id=_get_job_id(schedule.id),
            name=f"InsightSchedule-{schedule.id}",
            kwargs={"schedule_id": schedule.id},
            replace_existing=True,
            misfire_grace_time=3600,  # 1 小时内触发视为正常
        )

        # 更新 next_run_at
        next_run = scheduler.get_job(_get_job_id(schedule.id))
        if next_run and next_run.next_run_time:
            schedule.next_run_at = next_run.next_run_time.replace(tzinfo=None)
            logger.info(
                f"Registered job for schedule {schedule.id}, next_run: {schedule.next_run_at}"
            )

    except Exception as e:
        logger.error(f"Failed to register job for schedule {schedule.id}: {e}")


def _unregister_job(schedule_id: int) -> None:
    """从 APScheduler 移除 Job"""
    scheduler = _get_scheduler()
    if scheduler is None:
        return

    try:
        job_id = _get_job_id(schedule_id)
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)
            logger.info(f"Unregistered job for schedule {schedule_id}")
    except Exception as e:
        logger.error(f"Failed to unregister job for schedule {schedule_id}: {e}")


def reload_insight_schedules() -> None:
    """
    从数据库加载所有 is_active=True 的 schedule，注册为 APScheduler Jobs。
    由 scheduler.py 在启动时调用。
    """
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        schedules = db.execute(
            select(InsightSchedule).where(InsightSchedule.is_active == True)
        ).scalars().all()

        for schedule in schedules:
            _register_job(schedule)

        logger.info(f"Loaded {len(schedules)} insight schedules into scheduler")
    finally:
        db.close()


def shutdown_insight_schedules() -> None:
    """在应用关闭时清理所有 Jobs"""
    scheduler = _get_scheduler()
    if scheduler is not None:
        try:
            for job in scheduler.get_jobs():
                if job.id.startswith("insight_schedule_"):
                    scheduler.remove_job(job.id)
            logger.info("All insight schedule jobs removed from scheduler")
        except Exception as e:
            logger.error(f"Error shutting down insight schedules: {e}")


# -------------------------------------------------------------------------------------------------
# CRUD 操作
# -------------------------------------------------------------------------------------------------

def get_schedules(
    db: Session,
    project_id: int | None = None,
    is_active: bool | None = None,
    include_inactive: bool = True,
    insight_type: str | None = None,
) -> list[InsightSchedule]:
    """获取调度任务列表"""
    query = select(InsightSchedule)

    if project_id is not None:
        query = query.where(InsightSchedule.project_id == project_id)

    if is_active is not None:
        query = query.where(InsightSchedule.is_active == is_active)
    elif not include_inactive:
        query = query.where(InsightSchedule.is_active == True)

    if insight_type is not None:
        query = query.where(InsightSchedule.insight_type == insight_type)

    query = query.order_by(InsightSchedule.created_at.desc())
    return list(db.execute(query).scalars().all())


def create_schedule(
    db: Session,
    data,  # InsightScheduleCreate
    operator: str,
) -> InsightSchedule:
    """
    创建新的定时任务。
    - 保存到数据库
    - 注册 APScheduler Job（如果 is_active=True）
    """
    schedule = InsightSchedule(
        project_id=data.project_id,
        country=data.country,
        insight_type=data.insight_type,
        cron_expression=data.cron_expression,
        date_range_strategy=data.date_range_strategy,
        model=data.model,
        is_active=True,
        created_by=operator or "unknown",
    )
    db.add(schedule)
    db.commit()
    db.refresh(schedule)

    # 注册到 APScheduler
    _register_job(schedule)

    logger.info(f"Created insight schedule id={schedule.id} by {operator}")
    return schedule


def update_schedule(
    db: Session,
    schedule_id: int,
    data,  # InsightScheduleUpdate
    operator: str,
) -> InsightSchedule:
    """更新定时任务配置"""
    schedule = db.get(InsightSchedule, schedule_id)
    if not schedule:
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="定时任务不存在",
        )

    update_dict = data.model_dump(exclude_unset=True)
    for key, value in update_dict.items():
        setattr(schedule, key, value)

    db.commit()
    db.refresh(schedule)

    # 重新注册 APScheduler Job
    _unregister_job(schedule_id)
    if schedule.is_active:
        _register_job(schedule)

    logger.info(f"Updated insight schedule id={schedule_id} by {operator}")
    return schedule


def delete_schedule(
    db: Session,
    schedule_id: int,
) -> bool:
    """删除定时任务"""
    schedule = db.get(InsightSchedule, schedule_id)
    if not schedule:
        return False

    # 从 APScheduler 移除
    _unregister_job(schedule_id)

    db.delete(schedule)
    db.commit()

    logger.info(f"Deleted insight schedule id={schedule_id}")
    return True


def toggle_schedule(
    db: Session,
    schedule_id: int,
) -> InsightSchedule:
    """切换启用/禁用状态"""
    schedule = db.get(InsightSchedule, schedule_id)
    if not schedule:
        from fastapi import HTTPException, status

        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="定时任务不存在",
        )

    schedule.is_active = not schedule.is_active
    db.commit()
    db.refresh(schedule)

    # 更新 APScheduler Job
    if schedule.is_active:
        _register_job(schedule)
    else:
        _unregister_job(schedule_id)

    logger.info(
        f"Toggled insight schedule id={schedule_id}, is_active={schedule.is_active}"
    )
    return schedule


# -------------------------------------------------------------------------------------------------
# 立即执行
# -------------------------------------------------------------------------------------------------

def run_schedule_now(
    db: Session,
    schedule_id: int,
    operator: str | None,
) -> dict:
    """
    立即执行一次定时任务（run-now 按钮）。
    创建新的 AIInsight 记录并触发后台生成。
    """
    schedule = db.get(InsightSchedule, schedule_id)
    if not schedule:
        return {"error": "Schedule not found", "id": schedule_id}

    # 已切 canonical 的域不再新建旧 AIInsight 行（否则与 canonical run 双写）。
    # 抛 typed 409 而非 dict error：与 POST /ai-insights/generate 同一冻结语义。
    frozen_role = legacy_write_frozen(get_settings(), schedule.insight_type)
    if frozen_role:
        raise domain_switch_error(frozen_role, enabled=True)

    project = db.get(Project, schedule.project_id)
    if not project:
        return {"error": "Project not found", "id": schedule_id}

    # 计算日期范围
    start_date, end_date = calculate_date_range(schedule.date_range_strategy)

    # 创建 AIInsight 记录
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
        created_by=f"scheduler:{operator}" if operator else "scheduler:manual",
    )
    db.add(insight)
    db.commit()
    db.refresh(insight)

    # 触发后台生成
    _trigger_insight_generation(schedule.id, insight.id)

    return {
        "id": schedule_id,
        "insight_id": insight.id,
        "status": "pending",
        "message": f"洞察生成已启动，ID: {insight.id}",
    }


# -------------------------------------------------------------------------------------------------
# 调度触发（供 APScheduler 调用）
# -------------------------------------------------------------------------------------------------

def run_scheduled_insight(schedule_id: int) -> None:
    """APScheduler Job 回调：只把 schedule_id 投递到 Celery。"""
    logger.info(f"[Schedule-{schedule_id}] Triggered insight generation")

    with acquire_remote_semaphore("insights", timeout=300) as acquired:
        if not acquired:
            logger.warning(
                f"[Schedule-{schedule_id}] Could not acquire distributed slot "
                f"(max {MAX_CONCURRENT_INSIGHTS} concurrent), skipping this run"
            )
            return

    try:
        generate_insight.delay(schedule_id)
        logger.info(f"[Schedule-{schedule_id}] Enqueued insight generation")
    except Exception as e:
        logger.error(f"[Schedule-{schedule_id}] Failed to enqueue insight generation: {e}")
        _update_schedule_failure(schedule_id, str(e))


def _update_schedule_failure(schedule_id: int, error_message: str) -> None:
    """更新 schedule 的失败状态"""
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        schedule = db.get(InsightSchedule, schedule_id)
        if schedule:
            schedule.failure_count += 1
            schedule.last_error = error_message[:500]  # 截断
            db.commit()
    finally:
        db.close()


def _trigger_insight_generation(schedule_id: int, insight_id: int) -> None:
    """触发洞察生成（供 run_now 使用）。"""
    with acquire_remote_semaphore("insights", timeout=300) as acquired:
        if not acquired:
            logger.warning(
                f"[RunNow-{schedule_id}] Could not acquire distributed slot "
                f"(max {MAX_CONCURRENT_INSIGHTS} concurrent), skipping this run"
            )
            return

    try:
        generate_insight.delay(schedule_id, insight_id=insight_id)
        logger.info(f"[RunNow-{schedule_id}] Enqueued insight {insight_id}")
    except Exception as e:
        logger.error(f"[RunNow-{schedule_id}] Failed to enqueue insight generation: {e}")
        _update_schedule_failure(schedule_id, str(e))

"""
数字员工心跳上报服务。
供各业务模块调用，将运行状态同步到 digital_employees 表。
"""

from datetime import datetime, UTC
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.digital_employee import (
    DigitalEmployee,
    DigitalEmployeeLog,
    DigitalEmployeeTask,
    EmployeeStatus,
    LogLevel,
    TaskStatus,
)


def get_or_create_employee(db: Session, name: str, employee_type: str, description: str | None = None) -> DigitalEmployee:
    """根据名称查找或创建数字员工记录"""
    employee = db.execute(
        select(DigitalEmployee).where(
            DigitalEmployee.name == name,
            DigitalEmployee.is_deleted == 0,
        )
    ).scalar_one_or_none()

    if employee:
        return employee

    import secrets
    employee = DigitalEmployee(
        name=name,
        employee_type=employee_type,
        description=description,
        api_secret=secrets.token_urlsafe(32),
        status=EmployeeStatus.IDLE,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return employee


def report_heartbeat(
    db: Session,
    employee_id: int,
    task_id: str | None = None,
    status: str | None = None,
    progress_percent: int | None = None,
    current_step: str | None = None,
    message: str | None = None,
) -> None:
    """向数字员工上报心跳（由业务模块主动调用）"""
    try:
        db.rollback()  # clear any aborted transaction
    except Exception:
        pass
    now = datetime.now(UTC)
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        return

    employee.last_heartbeat_at = now

    task = None
    if task_id:
        task = db.execute(
            select(DigitalEmployeeTask).where(DigitalEmployeeTask.task_id == task_id)
        ).scalar_one_or_none()

    if task:
        if status:
            task.status = TaskStatus(status.lower())
        if progress_percent is not None:
            task.progress_percent = progress_percent
        if current_step is not None:
            task.current_step = current_step
        task.updated_at = now
        employee.status = EmployeeStatus(status.lower()) if status else employee.status

    if message:
        log = DigitalEmployeeLog(
            employee_id=employee_id,
            task_id=task.id if task else None,
            level=LogLevel.INFO,
            message=message,
        )
        db.add(log)

    db.commit()


def start_task(
    db: Session,
    employee_id: int,
    task_id: str,
    task_name: str,
    task_type: str,
    metadata_json: str | None = None,
) -> DigitalEmployeeTask:
    """为数字员工创建一个运行中任务"""
    now = datetime.now(UTC)
    task = DigitalEmployeeTask(
        employee_id=employee_id,
        task_id=task_id,
        task_name=task_name,
        task_type=task_type,
        status=TaskStatus.RUNNING,
        progress_percent=0,
        started_at=now,
        metadata_json=metadata_json,
    )
    db.add(task)
    employee = db.get(DigitalEmployee, employee_id)
    if employee:
        employee.status = EmployeeStatus.RUNNING
    db.commit()
    db.refresh(task)
    return task


def complete_task(
    db: Session,
    task_id: str,
    success: bool = True,
    error_message: str | None = None,
) -> None:
    """标记任务完成"""
    try:
        db.rollback()
    except Exception:
        pass
    now = datetime.now(UTC)
    task = db.execute(
        select(DigitalEmployeeTask).where(DigitalEmployeeTask.task_id == task_id)
    ).scalar_one_or_none()
    if not task:
        return
    task.status = TaskStatus.SUCCEEDED if success else TaskStatus.FAILED
    task.progress_percent = 100 if success else task.progress_percent
    task.current_step = "完成" if success else "失败"
    task.ended_at = now
    task.error_message = error_message

    employee = db.get(DigitalEmployee, task.employee_id)
    if employee:
        employee.status = EmployeeStatus.SUCCEEDED if success else EmployeeStatus.FAILED

    db.commit()


# ── 快速上报辅助函数 ──────────────────────────────────────────────────────────

def ai_insight_start(db: Session, employee_id: int, insight_id: int, project_name: str) -> str:
    """AI洞察生成开始，上报 RUNNING 状态，返回 task_id"""
    task_id = f"ai-insight-{insight_id}"
    start_task(db, employee_id, task_id, f"生成洞察报告：{project_name}", "ai_insight")
    report_heartbeat(db, employee_id, task_id, "RUNNING", 0, "准备数据")
    return task_id


def ai_insight_progress(db: Session, employee_id: int, task_id: str, step: str, progress: int) -> None:
    """AI洞察进度上报"""
    step_labels = {
        "data_aggregating": "聚合数据",
        "ai_generating": "AI 生成内容",
        "title_generating": "生成标题",
    }
    label = step_labels.get(step, step)
    report_heartbeat(db, employee_id, task_id, "RUNNING", progress, label)


def ai_insight_complete(db: Session, employee_id: int, task_id: str, success: bool, error: str | None = None) -> None:
    """AI洞察生成完成，上报 SUCCEEDED/FAILED"""
    report_heartbeat(
        db, employee_id, task_id,
        "SUCCEEDED" if success else "FAILED",
        100,
        "完成" if success else "失败",
        f"洞察报告生成{'成功' if success else '失败'}: {error}" if error else None,
    )
    complete_task(db, task_id, success, error)


def database_monitor_report(db: Session, employee_id: int, status: str, details: dict[str, Any] | None = None) -> None:
    """数据库监控专家状态上报"""
    import json
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        return
    employee.last_heartbeat_at = datetime.now(UTC)
    employee.status = EmployeeStatus(status)
    db.commit()

    # 写入一行日志记录监控摘要
    log = DigitalEmployeeLog(
        employee_id=employee_id,
        level=LogLevel.INFO,
        message=f"数据库监控: {details or {}}",
    )
    db.add(log)
    db.commit()
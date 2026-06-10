"""
Digital Employee Service — 数字化员工 CRUD + 任务执行逻辑。

从 endpoints/digital_employees.py 迁移（阶段 8.2）。
所有 CRUD 和任务/心跳逻辑封装于此，endpoint 仅做请求/响应转发。
"""
from __future__ import annotations

import secrets
from datetime import datetime, UTC
from typing import Any

from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.models.digital_employee import (
    DigitalEmployee,
    DigitalEmployeeLog,
    DigitalEmployeeTask,
    EmployeeStatus,
    EmployeeType,
    LogLevel,
    TaskStatus,
)


# ─── CRUD ────────────────────────────────────────────────────────────────────


def list_employees(
    db: Session,
    status: str | None = None,
    employee_type: str | None = None,
) -> tuple[list[dict], int]:
    """查询员工列表，返回 (items, total)。"""
    q = select(DigitalEmployee).where(DigitalEmployee.is_deleted == 0)
    if status:
        try:
            q = q.where(DigitalEmployee.status == EmployeeStatus(status))
        except ValueError:
            pass
    if employee_type:
        try:
            q = q.where(DigitalEmployee.employee_type == EmployeeType(employee_type))
        except ValueError:
            pass
    q = q.order_by(DigitalEmployee.created_at.desc())
    items = db.execute(q).scalars().all()
    total = len(items)
    serialized = [_serialize_employee(e) for e in items]
    return serialized, total


def get_employee(db: Session, employee_id: int) -> DigitalEmployee:
    """获取单个员工，不存在则抛出 404。"""
    from fastapi import HTTPException
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    return employee


def create_employee(db: Session, *, name: str, avatar_url: str | None, employee_type: str, description: str | None) -> DigitalEmployee:
    """创建新员工。返回持久化后的 ORM 对象。"""
    employee = DigitalEmployee(
        name=name,
        avatar_url=avatar_url,
        employee_type=EmployeeType(employee_type),
        description=description,
        api_secret=secrets.token_urlsafe(32),
        status=EmployeeStatus.IDLE,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return employee


def update_employee_status(db: Session, employee_id: int, status: str) -> DigitalEmployee:
    """更新员工状态。仅允许 suspended / idle。"""
    from fastapi import HTTPException
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    if status not in ("suspended", "idle"):
        raise HTTPException(status_code=400, detail="Only SUSPENDED or IDLE allowed")
    employee.status = EmployeeStatus(status)
    db.commit()
    db.refresh(employee)
    return employee


def delete_employee(db: Session, employee_id: int) -> None:
    """软删除员工。"""
    from fastapi import HTTPException
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    employee.is_deleted = 1
    db.commit()


# ─── Tasks ───────────────────────────────────────────────────────────────────


def list_tasks(
    db: Session, employee_id: int, page: int = 1, page_size: int = 20
) -> tuple[list[dict], int]:
    """查询员工的任务列表，返回 (items, total)。"""
    from fastapi import HTTPException
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")

    q = select(DigitalEmployeeTask).where(DigitalEmployeeTask.employee_id == employee_id)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    q = (
        q.order_by(desc(DigitalEmployeeTask.started_at))
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = db.execute(q).scalars().all()
    return [_serialize_task(t) for t in items], total


def get_task(db: Session, employee_id: int, task_id: int) -> DigitalEmployeeTask:
    """获取单个任务。"""
    from fastapi import HTTPException
    task = db.get(DigitalEmployeeTask, task_id)
    if not task or task.employee_id != employee_id:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


# ─── Logs ────────────────────────────────────────────────────────────────────


def list_logs(
    db: Session, employee_id: int, task_id: int, cursor: str | None = None, limit: int = 100
) -> tuple[list[dict], bool, str | None]:
    """查询任务日志，返回 (items, has_more, next_cursor)。"""
    from fastapi import HTTPException
    task = db.get(DigitalEmployeeTask, task_id)
    if not task or task.employee_id != employee_id:
        raise HTTPException(status_code=404, detail="Task not found")

    q = select(DigitalEmployeeLog).where(DigitalEmployeeLog.task_id == task_id)
    if cursor:
        q = q.where(DigitalEmployeeLog.id > int(cursor))
    q = q.order_by(DigitalEmployeeLog.id.asc()).limit(limit + 1)
    items = list(db.execute(q).scalars().all())
    has_more = len(items) > limit
    items = items[:limit]
    next_cursor = str(items[-1].id) if items else None
    return [_serialize_log(l) for l in items], has_more, next_cursor


def list_employee_logs(
    db: Session, employee_id: int, limit: int = 20
) -> list[dict]:
    """查询员工最近日志（不限 task），返回最新 N 条。"""
    q = (
        select(DigitalEmployeeLog)
        .where(DigitalEmployeeLog.employee_id == employee_id)
        .order_by(DigitalEmployeeLog.created_at.desc())
        .limit(limit)
    )
    items = list(db.execute(q).scalars().all())
    return [_serialize_log(l) for l in items]


# ─── Internal APIs ───────────────────────────────────────────────────────────


def register_employee(db: Session, *, name: str, employee_type: str, description: str | None, is_silent_alert_threshold_minutes: int | None) -> tuple[int, str]:
    """注册或查找员工。返回 (id, api_secret)。"""
    existing = db.execute(
        select(DigitalEmployee).where(
            DigitalEmployee.name == name,
            DigitalEmployee.is_deleted == 0,
        )
    ).scalar_one_or_none()
    if existing:
        return existing.id, existing.api_secret

    employee = DigitalEmployee(
        name=name,
        employee_type=EmployeeType(employee_type),
        description=description,
        api_secret=secrets.token_urlsafe(32),
        status=EmployeeStatus.IDLE,
        is_silent_alert_threshold_minutes=is_silent_alert_threshold_minutes,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return employee.id, employee.api_secret


def heartbeat(
    db: Session,
    employee_id: int,
    api_secret: str | None,
    task_id: str | None = None,
    status: str | None = None,
    progress_percent: int | None = None,
    current_step: str | None = None,
    message: str | None = None,
) -> datetime:
    """心跳上报。验证 api_secret，更新任务和员工状态。

    Returns:
        确认时间 (UTC datetime)
    """
    from fastapi import HTTPException
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    if api_secret and employee.api_secret != api_secret:
        raise HTTPException(status_code=401, detail="Invalid api_secret")

    now = datetime.now(UTC)
    employee.last_heartbeat_at = now

    task = None
    if task_id:
        task = db.execute(
            select(DigitalEmployeeTask).where(DigitalEmployeeTask.task_id == task_id)
        ).scalar_one_or_none()

    if task:
        if status:
            task.status = TaskStatus[status.upper()]
        if progress_percent is not None:
            task.progress_percent = progress_percent
        if current_step is not None:
            task.current_step = current_step
        task.updated_at = now
        employee.status = EmployeeStatus[task.status.name.upper()]

    if message:
        log = DigitalEmployeeLog(
            employee_id=employee_id,
            task_id=task.id if task else None,
            level=LogLevel.INFO,
            message=message,
        )
        db.add(log)

    db.commit()
    return now


# ─── 序列化 ──────────────────────────────────────────────────────────────────


def _serialize_employee(employee: DigitalEmployee) -> dict:
    from app.schemas.digital_employee import DigitalEmployeeResponse
    return DigitalEmployeeResponse.model_validate(employee).model_dump()


def _serialize_task(task: DigitalEmployeeTask) -> dict:
    from app.schemas.digital_employee import DigitalEmployeeTaskResponse
    return DigitalEmployeeTaskResponse.model_validate(task).model_dump()


def _serialize_log(log: DigitalEmployeeLog) -> dict:
    from app.schemas.digital_employee import DigitalEmployeeLogResponse
    return DigitalEmployeeLogResponse.model_validate(log).model_dump()
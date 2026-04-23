import secrets
from datetime import datetime, UTC

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, func, select
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, protected
from app.models.digital_employee import (
    DigitalEmployee,
    DigitalEmployeeLog,
    DigitalEmployeeTask,
    EmployeeStatus,
    EmployeeType,
    LogLevel,
    TaskStatus,
)
from app.schemas.digital_employee import (
    DigitalEmployeeCreate,
    DigitalEmployeeResponse,
    DigitalEmployeeListResponse,
    HeartbeatRequest,
    HeartbeatResponse,
    LogLevelSchema,
    LogListResponse,
    RegisterRequest,
    RegisterResponse,
    StatusUpdateRequest,
    TaskStatusSchema,
    TaskListResponse,
    DigitalEmployeeTaskResponse,
    DigitalEmployeeLogResponse,
)

router = APIRouter(prefix="/digital-employees", tags=["digital-employees"])


def _require_api_secret(employee: DigitalEmployee, secret: str | None) -> None:
    if not secret or employee.api_secret != secret:
        raise HTTPException(status_code=401, detail="Invalid api_secret")


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("", response_model=DigitalEmployeeListResponse)
def list_employees(
    status: str | None = None,
    employee_type: str | None = None,
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
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
    return DigitalEmployeeListResponse(
        items=[DigitalEmployeeResponse.model_validate(i) for i in items],
        total=total,
    )


@router.get("/{employee_id}", response_model=DigitalEmployeeResponse)
def get_employee(employee_id: int, db: Session = Depends(get_db_session), _=Depends(protected)):
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    return DigitalEmployeeResponse.model_validate(employee)


@router.post("", response_model=DigitalEmployeeResponse)
def create_employee(data: DigitalEmployeeCreate, db: Session = Depends(get_db_session), _=Depends(protected)):
    employee = DigitalEmployee(
        name=data.name,
        avatar_url=data.avatar_url,
        employee_type=EmployeeType(data.employee_type.value),
        description=data.description,
        api_secret=secrets.token_urlsafe(32),
        status=EmployeeStatus.IDLE,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return DigitalEmployeeResponse.model_validate(employee)


@router.patch("/{employee_id}/status", response_model=DigitalEmployeeResponse)
def update_status(
    employee_id: int,
    data: StatusUpdateRequest,
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    if data.status.value not in ("suspended", "idle"):
        raise HTTPException(status_code=400, detail="Only SUSPENDED or IDLE allowed")
    employee.status = EmployeeStatus(data.status.value)
    db.commit()
    db.refresh(employee)
    return DigitalEmployeeResponse.model_validate(employee)


@router.delete("/{employee_id}")
def delete_employee(employee_id: int, db: Session = Depends(get_db_session), _=Depends(protected)):
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    employee.is_deleted = 1
    db.commit()
    return {"ok": True}


# ── Tasks ─────────────────────────────────────────────────────────────────────

@router.get("/{employee_id}/tasks", response_model=TaskListResponse)
def list_tasks(
    employee_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    q = select(DigitalEmployeeTask).where(DigitalEmployeeTask.employee_id == employee_id)
    total = db.execute(select(func.count()).select_from(q.subquery())).scalar_one()
    q = q.order_by(desc(DigitalEmployeeTask.started_at)).offset((page - 1) * page_size).limit(page_size)
    items = db.execute(q).scalars().all()
    return TaskListResponse(
        items=[DigitalEmployeeTaskResponse.model_validate(i) for i in items],
        total=total,
    )


@router.get("/{employee_id}/tasks/{task_id}", response_model=DigitalEmployeeTaskResponse)
def get_task(
    employee_id: int,
    task_id: int,
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    task = db.get(DigitalEmployeeTask, task_id)
    if not task or task.employee_id != employee_id:
        raise HTTPException(status_code=404, detail="Task not found")
    return DigitalEmployeeTaskResponse.model_validate(task)


# ── Logs ─────────────────────────────────────────────────────────────────────

@router.get("/{employee_id}/tasks/{task_id}/logs", response_model=LogListResponse)
def list_logs(
    employee_id: int,
    task_id: int,
    cursor: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
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
    return LogListResponse(
        items=[DigitalEmployeeLogResponse.model_validate(i) for i in items],
        has_more=has_more,
        cursor=str(items[-1].id) if items else None,
    )


# ── Internal APIs ─────────────────────────────────────────────────────────────

@router.post("/register", response_model=RegisterResponse)
def register_employee(data: RegisterRequest, db: Session = Depends(get_db_session)):
    existing = db.execute(
        select(DigitalEmployee).where(
            DigitalEmployee.name == data.name,
            DigitalEmployee.is_deleted == 0,
        )
    ).scalar_one_or_none()
    if existing:
        return RegisterResponse(id=existing.id, api_secret=existing.api_secret)

    employee = DigitalEmployee(
        name=data.name,
        employee_type=EmployeeType(data.employee_type.value),
        description=data.description,
        api_secret=secrets.token_urlsafe(32),
        status=EmployeeStatus.IDLE,
        is_silent_alert_threshold_minutes=data.is_silent_alert_threshold_minutes,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)
    return RegisterResponse(id=employee.id, api_secret=employee.api_secret)


@router.post("/{employee_id}/heartbeat", response_model=HeartbeatResponse)
def heartbeat(
    employee_id: int,
    api_secret: str | None = None,
    data: HeartbeatRequest = None,
    db: Session = Depends(get_db_session),
):
    employee = db.get(DigitalEmployee, employee_id)
    if not employee or employee.is_deleted:
        raise HTTPException(status_code=404, detail="Employee not found")
    if api_secret and employee.api_secret != api_secret:
        raise HTTPException(status_code=401, detail="Invalid api_secret")

    now = datetime.now(UTC)
    employee.last_heartbeat_at = now

    task = None
    if data and data.task_id:
        task = db.execute(
            select(DigitalEmployeeTask).where(DigitalEmployeeTask.task_id == data.task_id)
        ).scalar_one_or_none()
        if task:
            if data.status:
                _ts_val = data.status.value.upper()  # e.g. "RUNNING"
                task.status = TaskStatus[_ts_val]
            if data.progress_percent is not None:
                task.progress_percent = data.progress_percent
            if data.current_step is not None:
                task.current_step = data.current_step
            task.updated_at = now
            # sync employee status from task status
            employee.status = EmployeeStatus[task.status.name.upper()]

    if data and data.message:
        log = DigitalEmployeeLog(
            employee_id=employee_id,
            task_id=task.id if task else None,
            level=LogLevel.INFO,
            message=data.message,
        )
        db.add(log)

    db.commit()
    return HeartbeatResponse(ok=True, acknowledged_at=now)
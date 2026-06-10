import secrets
from datetime import datetime, UTC

from fastapi import APIRouter, Depends, HTTPException, Query
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
from app.services.digital.employee_service import (
    heartbeat as _heartbeat,
    list_employees as _list_employees,
    get_employee as _get_employee,
    create_employee as _create_employee,
    update_employee_status as _update_employee_status,
    delete_employee as _delete_employee,
    list_tasks as _list_tasks,
    get_task as _get_task,
    list_logs as _list_logs,
    list_employee_logs as _list_employee_logs,
    register_employee as _register_employee,
)

router = APIRouter(prefix="/digital-employees", tags=["digital-employees"])


# ── CRUD ─────────────────────────────────────────────────────────────────────

@router.get("", response_model=DigitalEmployeeListResponse)
def list_employees_endpoint(
    status: str | None = None,
    employee_type: str | None = None,
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    items, total = _list_employees(db, status=status, employee_type=employee_type)
    return DigitalEmployeeListResponse(items=items, total=total)


@router.get("/{employee_id}", response_model=DigitalEmployeeResponse)
def get_employee_endpoint(employee_id: int, db: Session = Depends(get_db_session), _=Depends(protected)):
    employee = _get_employee(db, employee_id)
    return DigitalEmployeeResponse.model_validate(employee)


@router.post("", response_model=DigitalEmployeeResponse)
def create_employee_endpoint(data: DigitalEmployeeCreate, db: Session = Depends(get_db_session), _=Depends(protected)):
    employee = _create_employee(
        db,
        name=data.name,
        avatar_url=data.avatar_url,
        employee_type=data.employee_type.value,
        description=data.description,
    )
    return DigitalEmployeeResponse.model_validate(employee)


@router.patch("/{employee_id}/status", response_model=DigitalEmployeeResponse)
def update_status(
    employee_id: int,
    data: StatusUpdateRequest,
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    employee = _update_employee_status(db, employee_id, status=data.status.value)
    return DigitalEmployeeResponse.model_validate(employee)


@router.delete("/{employee_id}")
def delete_employee_endpoint(employee_id: int, db: Session = Depends(get_db_session), _=Depends(protected)):
    _delete_employee(db, employee_id)
    return {"ok": True}


# ── Tasks ─────────────────────────────────────────────────────────────────────

@router.get("/{employee_id}/tasks", response_model=TaskListResponse)
def list_tasks_endpoint(
    employee_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    items, total = _list_tasks(db, employee_id=employee_id, page=page, page_size=page_size)
    return TaskListResponse(items=items, total=total)


@router.get("/{employee_id}/tasks/{task_id}", response_model=DigitalEmployeeTaskResponse)
def get_task_endpoint(
    employee_id: int,
    task_id: int,
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    task = _get_task(db, employee_id, task_id)
    return DigitalEmployeeTaskResponse.model_validate(task)


# ── Logs ─────────────────────────────────────────────────────────────────────

@router.get("/{employee_id}/tasks/{task_id}/logs", response_model=LogListResponse)
def list_logs_endpoint(
    employee_id: int,
    task_id: int,
    cursor: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    items, has_more, next_cursor = _list_logs(db, employee_id=employee_id, task_id=task_id, cursor=cursor, limit=limit)
    return LogListResponse(
        items=items,
        has_more=has_more,
        cursor=next_cursor,
    )


@router.get("/{employee_id}/recent-logs")
def list_recent_logs_endpoint(
    employee_id: int,
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db_session),
    _=Depends(protected),
):
    items = _list_employee_logs(db, employee_id=employee_id, limit=limit)
    return {"items": items}


# ── Internal APIs ─────────────────────────────────────────────────────────────

@router.post("/register", response_model=RegisterResponse)
def register_employee_endpoint(data: RegisterRequest, db: Session = Depends(get_db_session)):
    employee_id, api_secret = _register_employee(
        db,
        name=data.name,
        employee_type=data.employee_type.value,
        description=data.description,
        is_silent_alert_threshold_minutes=data.is_silent_alert_threshold_minutes,
    )
    return RegisterResponse(id=employee_id, api_secret=api_secret)


@router.post("/{employee_id}/heartbeat", response_model=HeartbeatResponse)
def heartbeat_endpoint(
    employee_id: int,
    api_secret: str | None = None,
    data: HeartbeatRequest = None,
    db: Session = Depends(get_db_session),
):
    now = _heartbeat(
        db,
        employee_id=employee_id,
        api_secret=api_secret,
        task_id=data.task_id if data else None,
        status=data.status.value if data and data.status else None,
        progress_percent=data.progress_percent if data else None,
        current_step=data.current_step if data else None,
        message=data.message if data else None,
    )
    return HeartbeatResponse(ok=True, acknowledged_at=now)
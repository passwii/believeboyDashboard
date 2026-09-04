import enum
from datetime import datetime
from pydantic import BaseModel, Field


class EmployeeTypeSchema(str, enum.Enum):
    AUTO_REPORT_UPLOAD = "auto_report_upload"
    SCHEDULED_JOB = "scheduled_job"
    RPA_BOT = "rpa_bot"
    AI_AGENT = "ai_agent"
    MONITORING = "monitoring"
    DATABASE = "database"
    CUSTOM = "custom"


class EmployeeStatusSchema(str, enum.Enum):
    IDLE = "idle"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SUSPENDED = "suspended"


class TaskStatusSchema(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class LogLevelSchema(str, enum.Enum):
    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


# ── Employee ──────────────────────────────────────────────────────────────────

class DigitalEmployeeBase(BaseModel):
    name: str = Field(max_length=128)
    avatar_url: str | None = None
    employee_type: EmployeeTypeSchema
    description: str | None = None


class DigitalEmployeeCreate(DigitalEmployeeBase):
    pass


class DigitalEmployeeResponse(DigitalEmployeeBase):
    id: int
    status: EmployeeStatusSchema
    last_heartbeat_at: datetime | None
    is_silent_alert_threshold_minutes: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DigitalEmployeeListResponse(BaseModel):
    items: list[DigitalEmployeeResponse]
    total: int


class StatusUpdateRequest(BaseModel):
    status: EmployeeStatusSchema


# ── Task ─────────────────────────────────────────────────────────────────────

class DigitalEmployeeTaskResponse(BaseModel):
    id: int
    task_id: str
    task_name: str
    task_type: str
    status: TaskStatusSchema
    progress_percent: int
    current_step: str | None
    started_at: datetime | None
    ended_at: datetime | None
    error_message: str | None
    metadata_json: dict | None
    created_at: datetime

    model_config = {"from_attributes": True}


class TaskListResponse(BaseModel):
    items: list[DigitalEmployeeTaskResponse]
    total: int


# ── Log ───────────────────────────────────────────────────────────────────────

class DigitalEmployeeLogResponse(BaseModel):
    id: int
    task_id: int | None
    level: LogLevelSchema
    message: str
    created_at: datetime

    model_config = {"from_attributes": True}


class LogListResponse(BaseModel):
    items: list[DigitalEmployeeLogResponse]
    has_more: bool
    cursor: str | None


# ── Internal APIs ─────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    name: str = Field(max_length=128)
    employee_type: EmployeeTypeSchema
    description: str | None = None
    is_silent_alert_threshold_minutes: int = 30


class RegisterResponse(BaseModel):
    id: int
    api_secret: str


class HeartbeatRequest(BaseModel):
    task_id: str | None = None
    task_name: str | None = Field(default=None, max_length=256)
    task_type: str | None = Field(default=None, max_length=64)
    status: TaskStatusSchema | None = None
    progress_percent: int | None = Field(default=None, ge=0, le=100)
    current_step: str | None = None
    message: str | None = None
    metadata_json: dict | None = None


class HeartbeatResponse(BaseModel):
    ok: bool
    acknowledged_at: datetime
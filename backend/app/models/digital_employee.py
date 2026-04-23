import enum
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class EmployeeType(str, enum.Enum):
    AUTO_REPORT_UPLOAD = "auto_report_upload"
    SCHEDULED_JOB = "scheduled_job"
    RPA_BOT = "rpa_bot"
    AI_AGENT = "ai_agent"
    MONITORING = "monitoring"
    DATABASE = "database"
    CUSTOM = "custom"


class EmployeeStatus(str, enum.Enum):
    IDLE = "idle"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SUSPENDED = "suspended"


class TaskStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class LogLevel(str, enum.Enum):
    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class DigitalEmployee(Base):
    __tablename__ = "digital_employees"
    __table_args__ = (
        Index("idx_de_status", "status"),
        Index("idx_de_type", "employee_type"),
        Index("idx_de_last_heartbeat", "last_heartbeat_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False, index=True)
    avatar_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    employee_type: Mapped[EmployeeType] = mapped_column(
        Enum(EmployeeType), nullable=False, index=True
    )
    status: Mapped[EmployeeStatus] = mapped_column(
        Enum(EmployeeStatus), nullable=False, default=EmployeeStatus.IDLE, index=True
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    api_secret: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    is_silent_alert_threshold_minutes: Mapped[int] = mapped_column(
        Integer, nullable=False, default=30
    )
    is_deleted: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now()
    )

    tasks: Mapped[list["DigitalEmployeeTask"]] = relationship(
        back_populates="employee", cascade="all, delete-orphan"
    )
    logs: Mapped[list["DigitalEmployeeLog"]] = relationship(
        back_populates="employee", cascade="all, delete-orphan"
    )


class DigitalEmployeeTask(Base):
    __tablename__ = "digital_employee_tasks"
    __table_args__ = (
        Index("idx_det_employee_id", "employee_id"),
        Index("idx_det_status", "status"),
        Index("idx_det_started_at", "started_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("digital_employees.id", ondelete="CASCADE"),
        nullable=False,
    )
    task_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    task_name: Mapped[str] = mapped_column(String(256), nullable=False)
    task_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus), nullable=False, default=TaskStatus.PENDING, index=True
    )
    progress_percent: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_step: Mapped[str | None] = mapped_column(String(256), nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[dict | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(), onupdate=func.now()
    )

    employee: Mapped["DigitalEmployee"] = relationship(back_populates="tasks")
    log_entries: Mapped[list["DigitalEmployeeLog"]] = relationship(
        back_populates="task", cascade="all, delete-orphan"
    )


class DigitalEmployeeLog(Base):
    __tablename__ = "digital_employee_logs"
    __table_args__ = (
        Index("idx_del_employee_id", "employee_id"),
        Index("idx_del_task_id", "task_id"),
        Index("idx_del_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    employee_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("digital_employees.id", ondelete="CASCADE"),
        nullable=False,
    )
    task_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("digital_employee_tasks.id", ondelete="CASCADE"),
        nullable=True,
    )
    level: Mapped[LogLevel] = mapped_column(
        Enum(LogLevel), nullable=False, default=LogLevel.INFO
    )
    message: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    employee: Mapped["DigitalEmployee"] = relationship(back_populates="logs")
    task: Mapped[DigitalEmployeeTask | None] = relationship(back_populates="log_entries")
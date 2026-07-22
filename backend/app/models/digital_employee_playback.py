from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class DigitalEmployeePlayback(Base):
    """每员工一行的虚拟播放游标（拟人化伸展引擎状态）。"""
    __tablename__ = "digital_employee_playback"

    employee_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("digital_employees.id", ondelete="CASCADE"), primary_key=True
    )
    virtual_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    virtual_progress: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    display_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    display_duration_s: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    pause_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    pace: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    busy_level: Mapped[str] = mapped_column(String(16), nullable=False, default="IDLE")
    last_advanced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

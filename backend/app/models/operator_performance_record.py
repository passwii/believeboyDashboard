from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class OperatorPerformanceRecord(Base):
    __tablename__ = 'operator_performance_records'
    __table_args__ = (
        UniqueConstraint(
            'report_month',
            'week_index',
            'project_id',
            'person_name',
            'role_type',
            name='operator_performance_records_unique_scope',
        ),
        CheckConstraint("report_month LIKE '____-__'", name='ck_operator_performance_records_report_month_format'),
        CheckConstraint('week_index >= 1 and week_index <= 5', name='ck_operator_performance_records_week_index'),
        CheckConstraint('score >= 0 and score <= 100', name='ck_operator_performance_records_score'),
        CheckConstraint("length(trim(role_type)) > 0", name='ck_operator_performance_records_role_type_nonempty'),
        Index('idx_operator_performance_records_month', 'report_month'),
        Index('idx_operator_performance_records_person_month', 'person_name', 'report_month'),
        Index('idx_operator_performance_records_project_month', 'project_id', 'report_month'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    report_month: Mapped[str] = mapped_column(String(7), nullable=False)
    week_index: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    person_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    role_type: Mapped[str] = mapped_column(String(32), nullable=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

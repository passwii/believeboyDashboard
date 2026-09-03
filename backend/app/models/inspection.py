from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class InspectionPeriod(Base):
    __tablename__ = 'inspection_periods'
    __table_args__ = (
        UniqueConstraint('week_start', name='uq_inspection_periods_week_start'),
        Index('idx_inspection_periods_week_start', 'week_start'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    week_start: Mapped[date] = mapped_column(Date(), nullable=False)
    week_end: Mapped[date] = mapped_column(Date(), nullable=False)
    deadline: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    reports: Mapped[list['InspectionReport']] = relationship(
        back_populates='period',
        cascade='all, delete-orphan',
    )


class InspectionReport(Base):
    __tablename__ = 'inspection_reports'
    __table_args__ = (
        UniqueConstraint(
            'period_id', 'project_id', 'country',
            name='uq_inspection_reports_period_project_country',
        ),
        Index('idx_inspection_reports_period_id', 'period_id'),
        Index('idx_inspection_reports_project_id', 'project_id'),
        Index('idx_inspection_reports_period_status', 'period_id', 'status'),
        Index('idx_inspection_reports_project_country', 'project_id', 'country'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    period_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('inspection_periods.id', ondelete='CASCADE'),
        nullable=False,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, server_default='US')
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='draft')
    health_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    compliance_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    status_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    period: Mapped[InspectionPeriod] = relationship(back_populates='reports')
    screenshots: Mapped[list['InspectionScreenshot']] = relationship(
        back_populates='report',
        cascade='all, delete-orphan',
    )


class InspectionScreenshot(Base):
    __tablename__ = 'inspection_screenshots'
    __table_args__ = (
        Index('idx_inspection_screenshots_report_id', 'report_id'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    report_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('inspection_reports.id', ondelete='CASCADE'),
        nullable=False,
    )
    r2_key: Mapped[str] = mapped_column(String(512), nullable=False)
    thumbnail_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    filename: Mapped[str] = mapped_column(String(256), nullable=False)
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, nullable=False)
    caption: Mapped[str | None] = mapped_column(String(256), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )

    report: Mapped[InspectionReport] = relationship(back_populates='screenshots')

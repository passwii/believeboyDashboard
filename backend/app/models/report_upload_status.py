from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ReportUploadStatus(Base):
    __tablename__ = 'report_upload_statuses'
    __table_args__ = (
        UniqueConstraint(
            'project_id',
            'report_type',
            'country',
            'report_date',
            name='report_upload_statuses_project_type_country_date_key',
        ),
        Index('idx_report_upload_statuses_project', 'project_id'),
        Index('idx_report_upload_statuses_type', 'report_type'),
        Index('idx_report_upload_statuses_country', 'country'),
        Index('idx_report_upload_statuses_report_date', 'report_date'),
    )

    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    report_date: Mapped[date] = mapped_column(Date(), nullable=False)
    upload_file_id: Mapped[str] = mapped_column(String(255), nullable=False)
    upload_file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    stored_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_size_bytes: Mapped[int | None] = mapped_column(BigInteger().with_variant(Integer, "sqlite"), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

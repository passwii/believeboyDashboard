"""Report upload logs — single source of truth for RPA status checks."""

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ReportUploadLog(Base):
    """Records every file upload attempt for RPA status dashboard.

    One row per processed file, regardless of whether it contained real data.
    """

    __tablename__ = "report_upload_logs"
    __table_args__ = (
        Index("idx_upload_logs_lookup", "project_id", "report_type", "country", "upload_date"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    report_type: Mapped[str] = mapped_column(String(32), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US", server_default="US")
    upload_date: Mapped[date] = mapped_column(Date(), nullable=False)
    has_real_data: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    row_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    source_file_id: Mapped[int | None] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("analysis_source_files.id", ondelete="SET NULL"),
        nullable=True,
    )
    original_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    source_file: Mapped["AnalysisSourceFile"] = relationship("AnalysisSourceFile")

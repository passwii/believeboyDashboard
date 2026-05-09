import enum
from datetime import date, datetime

from sqlalchemy import BigInteger, Date, DateTime, Enum, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class InsightStatus(str, enum.Enum):
    pending = 'pending'
    generating = 'generating'  # 兼容旧状态，作为 generatng 组的主状态
    # 细粒度子阶段（用于前端展示进度）
    data_aggregating = 'data_aggregating'
    ai_generating = 'ai_generating'
    title_generating = 'title_generating'
    completed = 'completed'
    failed = 'failed'


class InsightType(str, enum.Enum):
    daily = 'daily'
    weekly = 'weekly'
    monthly = 'monthly'
    custom = 'custom'


class AIInsight(Base):
    __tablename__ = 'ai_insights'
    __table_args__ = (
        Index('idx_ai_insights_project_id', 'project_id'),
        Index('idx_ai_insights_project_country', 'project_id', 'country'),
        Index('idx_ai_insights_created_at', 'created_at'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False, default='')
    insight_type: Mapped[InsightType] = mapped_column(Enum(InsightType), nullable=False, default=InsightType.custom)

    date_range_start: Mapped[date] = mapped_column(Date, nullable=False)
    date_range_end: Mapped[date] = mapped_column(Date, nullable=False)

    status: Mapped[InsightStatus] = mapped_column(
        Enum(InsightStatus), nullable=False, default=InsightStatus.pending, index=True
    )
    sub_status: Mapped[str | None] = mapped_column(String(32), nullable=True)  # data_aggregating / ai_generating / title_generating
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_by: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

"""
Ad Agent 分析运行记录模型
=========================
记录每次 Agent Pipeline 的运行元数据，用于进化引擎的历史追踪。
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy import BigInteger, Date, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AdAgentRun(Base):
    """单次 Agent Pipeline 运行记录。"""

    __tablename__ = "ad_agent_runs"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    run_id: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    insight_id: Mapped[Optional[int]] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), nullable=True
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), nullable=False, index=True
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    date_range_start: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    date_range_end: Mapped[Optional[date]] = mapped_column(Date, nullable=True)

    # 策略数据 (JSON strings)
    dimensions_analyzed: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    cross_analyses_performed: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    temporal_analyses_performed: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    dimensions_skipped: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    data_source_signals: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    quality_signals: Mapped[str] = mapped_column(Text, nullable=False, default="[]")

    prompt_version: Mapped[str] = mapped_column(String(20), nullable=False, default="v2")
    user_feedback: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

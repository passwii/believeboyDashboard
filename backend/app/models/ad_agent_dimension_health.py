"""
Ad Agent 维度健康追踪模型
=========================
追踪每个分析维度在每次运行中的信号强度和分析状态，
用于进化引擎的长期趋势分析。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AdAgentDimensionHealth(Base):
    """单次运行中某个维度的健康记录。"""

    __tablename__ = "ad_agent_dimension_health"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    dimension_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    signal_strength: Mapped[str] = mapped_column(String(20), nullable=False)
    was_analyzed: Mapped[bool] = mapped_column(Boolean, default=True)
    skip_reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        Index("idx_dim_health_dimension_run", "dimension_id", "run_id"),
    )

"""Return analysis aggregate snapshot.

BEL-373 数据层（BEL-372 拍板方案 §2.1）：
- 每日 03:00 UTC Celery 任务刷新近 90 天增量
- 内部 /api/v1/return-analysis 优先查此表，25h 未刷新走 fallback
- 主 risk_level 用 30d 滚动窗，data_date 是单日不是整周期
  endpoint 查询时按 data_date BETWEEN start AND end 聚合

字段说明：
- return_count: 退货单数（按 order_id+sku 去重）
- return_quantity: 退货件数（累加）
- sales_quantity: 同日同期销售件数（join sales_order）
- return_rate: return_quantity / sales_quantity * 100
- wilson_lower: Wilson 95% 下界百分比，audit 用
- risk_level: critical/warning/normal/no_data（销量门槛 15 + Wilson 下界判定）
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AnalysisReturnAggregate(Base):
    """Return analysis aggregate snapshot — daily grain per (project, country, sku, date)."""

    __tablename__ = "analysis_return_aggregates"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "country",
            "sku",
            "data_date",
            name="uq_return_agg_project_country_sku_date",
        ),
        Index("idx_return_agg_project_date", "project_id", "data_date"),
        Index("idx_return_agg_project_sku_date", "project_id", "sku", "data_date"),
        Index(
            "idx_return_agg_risk",
            "project_id",
            "country",
            "risk_level",
            "data_date",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    sku: Mapped[str] = mapped_column(String(100), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(20), nullable=True)
    data_date: Mapped[date] = mapped_column(
        Date, nullable=False, comment="退货日期（PT）"
    )
    return_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    return_quantity: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    sales_quantity: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    return_rate: Mapped[float] = mapped_column(
        Numeric(6, 3), nullable=False, default=0, server_default="0"
    )
    cycle_avg_days: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    cycle_min_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cycle_max_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reason_top1: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reason_top1_pct: Mapped[float | None] = mapped_column(Numeric(5, 2), nullable=True)
    reason_top1_display: Mapped[str | None] = mapped_column(String(64), nullable=True)
    disposition_top1: Mapped[str | None] = mapped_column(String(50), nullable=True)
    disposition_top1_display: Mapped[str | None] = mapped_column(
        String(64), nullable=True
    )
    dominant_fc_id: Mapped[str | None] = mapped_column(String(20), nullable=True)
    risk_level: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="normal",
        server_default="normal",
        comment="critical/warning/normal/no_data",
    )
    wilson_lower: Mapped[float | None] = mapped_column(
        Numeric(6, 3), nullable=True, comment="Wilson 95% 下界（百分比），audit 用"
    )
    data_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    computed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ShipmentSkuSummary(Base):
    __tablename__ = "shipment_sku_summaries"
    __table_args__ = (
        UniqueConstraint("project_id", "sku", "country", name="shipment_sku_summaries_project_sku_country_key"),
        Index("idx_shipment_sku_summaries_project_name", "project_name_snapshot"),
        Index("idx_shipment_sku_summaries_country", "country"),
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
        index=True,
    )
    project_name_snapshot: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="US", server_default="US")
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    shipment_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    total_quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    total_chargeable_weight_kg: Mapped[float] = mapped_column(
        Numeric(14, 3), nullable=False, default=0, server_default="0"
    )
    total_logistics_cost: Mapped[float] = mapped_column(
        Numeric(14, 2), nullable=False, default=0, server_default="0"
    )
    average_logistics_unit_price: Mapped[float] = mapped_column(
        Numeric(14, 4), nullable=False, default=0, server_default="0"
    )
    refreshed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

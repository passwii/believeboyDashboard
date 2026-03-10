from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class InventoryReplenishmentSetting(Base):
    __tablename__ = 'inventory_replenishment_settings'
    __table_args__ = (
        UniqueConstraint('project_id', 'sku', 'country', name='uq_inventory_replenishment_settings_project_sku_country'),
        CheckConstraint('production_lead_days >= 0', name='ck_inventory_replenishment_settings_production_lead_days'),
        CheckConstraint('shipping_days >= 0', name='ck_inventory_replenishment_settings_shipping_days'),
        CheckConstraint('safety_factor >= 0', name='ck_inventory_replenishment_settings_safety_factor'),
        Index('idx_inventory_replenishment_settings_project_id', 'project_id'),
        Index('idx_inventory_replenishment_settings_project_sku_country', 'project_id', 'sku', 'country'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    production_lead_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default='20')
    shipping_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default='25')
    safety_factor: Mapped[Decimal] = mapped_column(Numeric(8, 4), nullable=False, server_default='0.20')
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

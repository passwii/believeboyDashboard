from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ShippingPlanSkuSetting(Base):
    __tablename__ = "shipping_plan_sku_settings"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "country", "sku", name="uq_shipping_plan_sku_settings_scope"
        ),
        CheckConstraint(
            "growth_factor >= 0", name="ck_shipping_plan_sku_settings_growth_factor_non_negative"
        ),
        Index("idx_shipping_plan_sku_settings_project_country", "project_id", "country"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    growth_factor: Mapped[Decimal] = mapped_column(
        Numeric(8, 4), nullable=False, server_default="1.0"
    )
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class ShippingPlanBatch(Base):
    __tablename__ = "shipping_plan_batches"
    __table_args__ = (
        CheckConstraint("status in ('active', 'cancelled')", name="ck_shipping_plan_batches_status"),
        Index("idx_shipping_plan_batches_project_country", "project_id", "country"),
        Index("idx_shipping_plan_batches_status_arrival", "status", "expected_arrival_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    expected_arrival_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default="active")
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    items: Mapped[list[ShippingPlanItem]] = relationship(
        back_populates="batch", cascade="all, delete-orphan", passive_deletes=True
    )


class ShippingPlanItem(Base):
    __tablename__ = "shipping_plan_items"
    __table_args__ = (
        UniqueConstraint("batch_id", "sku", name="uq_shipping_plan_items_batch_sku"),
        CheckConstraint("quantity > 0", name="ck_shipping_plan_items_quantity_positive"),
        Index("idx_shipping_plan_items_sku", "sku"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("shipping_plan_batches.id", ondelete="CASCADE"), nullable=False
    )
    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)

    batch: Mapped[ShippingPlanBatch] = relationship(back_populates="items")
    allocations: Mapped[list[ShippingPlanAllocation]] = relationship(
        back_populates="plan_item", cascade="all, delete-orphan", passive_deletes=True
    )


class ShippingPlanAllocation(Base):
    __tablename__ = "shipping_plan_allocations"
    __table_args__ = (
        UniqueConstraint(
            "plan_item_id", "shipment_schedule_id", name="uq_shipping_plan_allocations_item_schedule"
        ),
        CheckConstraint("quantity > 0", name="ck_shipping_plan_allocations_quantity_positive"),
        Index("idx_shipping_plan_allocations_schedule_sku", "shipment_schedule_id", "sku"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_item_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("shipping_plan_items.id", ondelete="CASCADE"), nullable=False
    )
    shipment_schedule_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("shipment_schedules.id", ondelete="CASCADE"),
        nullable=False,
    )
    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)

    plan_item: Mapped[ShippingPlanItem] = relationship(back_populates="allocations")

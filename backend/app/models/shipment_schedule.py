from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ShipmentSchedule(Base):
    __tablename__ = 'shipment_schedules'
    __table_args__ = (
        UniqueConstraint('shipment_no', name='shipment_schedules_shipment_no_key'),
        CheckConstraint(
            "shipment_status in ('draft', 'preparing', 'in_transit', 'arrived_port', 'inbound_processing', 'completed', 'cancelled')",
            name='ck_shipment_schedules_status',
        ),
        CheckConstraint(
            "shipping_method in ('sea', 'air', 'express', 'truck', 'rail', 'other')",
            name='ck_shipment_schedules_method',
        ),
        Index('idx_shipment_schedules_project_status', 'project_id', 'shipment_status'),
        Index('idx_shipment_schedules_etd', 'etd_date'),
        Index('idx_shipment_schedules_eta', 'eta_date'),
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
        index=True,
    )
    project_name_snapshot: Mapped[str] = mapped_column(String(255), nullable=False)
    shipment_no: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    tracking_no: Mapped[str | None] = mapped_column(String(100), nullable=True)
    warehouse_code: Mapped[str | None] = mapped_column(String(100), nullable=True)
    forwarder_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    shipping_method: Mapped[str] = mapped_column(String(50), nullable=False, server_default='sea')
    created_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    etd_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    eta_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    expected_inbound_start_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    expected_inbound_end_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    booking_note: Mapped[str | None] = mapped_column(Text(), nullable=True)
    forwarder_update: Mapped[str | None] = mapped_column(Text(), nullable=True)
    remark: Mapped[str | None] = mapped_column(Text(), nullable=True)
    shipment_status: Mapped[str] = mapped_column(String(30), nullable=False, server_default='draft', index=True)
    stat_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    source_type: Mapped[str] = mapped_column(String(20), nullable=False, server_default='manual')
    source_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    items: Mapped[list['ShipmentScheduleItem']] = relationship(
        back_populates='schedule',
        cascade='all, delete-orphan',
    )


class ShipmentScheduleItem(Base):
    __tablename__ = 'shipment_schedule_items'
    __table_args__ = (
        UniqueConstraint('shipment_schedule_id', 'sku', name='shipment_schedule_items_schedule_sku_key'),
        CheckConstraint('quantity > 0', name='ck_shipment_schedule_items_quantity_positive'),
        Index('idx_shipment_schedule_items_project_id', 'project_id'),
        Index('idx_shipment_schedule_items_shipment_no', 'shipment_no'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    shipment_schedule_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('shipment_schedules.id', ondelete='CASCADE'),
        nullable=False,
        index=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    shipment_no: Mapped[str] = mapped_column(String(100), nullable=False)
    item_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    sku: Mapped[str] = mapped_column(String(100), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    remark: Mapped[str | None] = mapped_column(Text(), nullable=True)
    source_type: Mapped[str] = mapped_column(String(20), nullable=False, server_default='manual')
    source_file: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    schedule: Mapped[ShipmentSchedule] = relationship(back_populates='items')

from __future__ import annotations
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from sqlalchemy import (
    BigInteger, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer,
    JSON, Numeric, String, Text, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.session import Base


def _money_column() -> Mapped[Decimal]:
    return mapped_column(Numeric(18, 2), nullable=False, server_default='0')


class VatInvoice(Base):
    __tablename__ = 'vat_invoices'
    __table_args__ = (
        UniqueConstraint('project_id', 'invoice_no', name='uq_vat_invoices_project_no'),
        Index('idx_vat_invoices_project', 'project_id'),
        Index('idx_vat_invoices_date', 'invoice_date'),
        CheckConstraint("status IN ('draft','issued','voided')", name='ck_vat_invoices_status'),
    )
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    invoice_no: Mapped[str] = mapped_column(String(64), nullable=False)
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
    seller_entity_id: Mapped[int | None] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('vat_entities.id', ondelete='SET NULL'), nullable=True)
    seller_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    buyer: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    order_id: Mapped[str] = mapped_column(String(64), nullable=False, default='')
    invoice_date: Mapped[date] = mapped_column(Date, nullable=False)
    shipping_incl_vat: Mapped[Decimal] = _money_column()
    subtotal_excl: Mapped[Decimal] = _money_column()
    total_vat: Mapped[Decimal] = _money_column()
    total_incl: Mapped[Decimal] = _money_column()
    summary_by_rate: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='draft')
    created_by: Mapped[str | None] = mapped_column(String(128), nullable=True)
    void_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

    lines: Mapped[list['VatInvoiceLine']] = relationship(
        back_populates='invoice', cascade='all, delete-orphan',
    )


class VatInvoiceLine(Base):
    __tablename__ = 'vat_invoice_lines'
    __table_args__ = (
        UniqueConstraint('invoice_id', 'line_no', name='uq_vat_invoice_lines_inv_no'),
        Index('idx_vat_invoice_lines_inv', 'invoice_id'),
    )
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    invoice_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('vat_invoices.id', ondelete='CASCADE'), nullable=False)
    line_no: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(String(512), nullable=False, default='')
    asin: Mapped[str] = mapped_column(String(32), nullable=False, default='')
    qty: Mapped[int] = mapped_column(Integer, nullable=False, server_default='1')
    unit_price_incl_vat: Mapped[Decimal] = _money_column()
    vat_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, server_default='0')
    line_excl: Mapped[Decimal] = _money_column()
    line_vat: Mapped[Decimal] = _money_column()
    line_incl: Mapped[Decimal] = _money_column()

    invoice: Mapped['VatInvoice'] = relationship(back_populates='lines')

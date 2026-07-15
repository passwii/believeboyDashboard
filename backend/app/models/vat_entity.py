from __future__ import annotations
from datetime import datetime
from sqlalchemy import (
    BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.db.session import Base


class VatEntity(Base):
    __tablename__ = 'vat_entities'
    __table_args__ = (
        UniqueConstraint('project_id', 'country', name='uq_vat_entities_project_country'),
        Index('idx_vat_entities_project', 'project_id'),
    )
    id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(BigInteger().with_variant(Integer, 'sqlite'), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    company_name: Mapped[str] = mapped_column(String(255), nullable=False)
    vat_id: Mapped[str] = mapped_column(String(64), nullable=False, default='')
    address_line: Mapped[str] = mapped_column(String(512), nullable=False, default='')
    postal_code: Mapped[str] = mapped_column(String(32), nullable=False, default='')
    city: Mapped[str] = mapped_column(String(128), nullable=False, default='')
    email: Mapped[str] = mapped_column(String(255), nullable=False, default='')
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='0')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())

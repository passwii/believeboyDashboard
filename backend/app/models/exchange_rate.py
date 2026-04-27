from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Integer, JSON, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ExchangeRate(Base):
    __tablename__ = 'exchange_rates'
    __table_args__ = (
        UniqueConstraint('currency', 'year_month', name='exchange_rates_currency_year_month_key'),
        CheckConstraint('rate > 0', name='exchange_rates_rate_check'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger(),
        primary_key=True,
        autoincrement=True,
    )
    currency: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    currency_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    year_month: Mapped[str] = mapped_column(String(7), nullable=False, index=True)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    note_images: Mapped[list[dict[str, object]] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

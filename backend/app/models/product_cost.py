from datetime import datetime
from sqlalchemy import BigInteger, DateTime, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ProductCost(Base):
    __tablename__ = 'product_costs'
    __table_args__ = (UniqueConstraint('project_name', 'sku', 'asin', name='product_costs_project_sku_asin_key'),)

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    sku: Mapped[str] = mapped_column(String, nullable=False, index=True)
    asin: Mapped[str] = mapped_column(String, nullable=False, index=True)
    first_leg_unit_cost: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    fob_unit_cost: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String, nullable=False, default='USD')
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

from datetime import datetime
from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ProductCost(Base):
    __tablename__ = 'product_costs'
    __table_args__ = (
        UniqueConstraint('project_name', 'sku', 'asin', 'country', name='product_costs_project_sku_asin_country_key'),
        Index('idx_product_costs_project_sort', 'project_name', 'sort_order', 'id'),
        Index('idx_product_costs_project_sku_active', 'project_name', 'sku', 'is_active'),
    )

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
    currency: Mapped[str] = mapped_column(String, nullable=False, default='CNY', server_default='CNY')
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US', index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=1, server_default='1', index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default='true', index=True)
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

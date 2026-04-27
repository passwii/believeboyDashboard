from datetime import datetime
from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ProductCost(Base):
    __tablename__ = "product_costs"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "sku",
            "asin",
            "country",
            name="product_costs_project_id_sku_asin_country_key",
        ),
        Index("idx_product_costs_project_id", "project_id"),
        Index("idx_product_costs_project_sort", "project_id", "sort_order", "id"),
        Index(
            "idx_product_costs_project_sku_active", "project_id", "sku", "is_active"
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger(),
        ForeignKey("projects.id", ondelete="RESTRICT"),
        nullable=False,
    )
    project: Mapped["Project"] = relationship(back_populates="product_costs")
    # project_name is kept as a read-only denormalized field for historical queries.
    # Write operations must use project_id; this column is populated via triggers
    # or application-level sync (see product_cost_service).
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    sku: Mapped[str] = mapped_column(String, nullable=False, index=True)
    asin: Mapped[str] = mapped_column(String, nullable=False, index=True)
    fnsku: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    product_name: Mapped[str | None] = mapped_column(String, nullable=True)
    fob_unit_cost: Mapped[float] = mapped_column(
        Numeric(12, 2), nullable=False, default=0
    )
    first_leg_cost_rmb: Mapped[float] = mapped_column(
        Numeric(12, 2), nullable=False, default=0, server_default="0"
    )
    package_length_cm: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False, default=0, server_default="0"
    )
    package_width_cm: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False, default=0, server_default="0"
    )
    package_height_cm: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False, default=0, server_default="0"
    )
    weight_kg: Mapped[float] = mapped_column(
        Numeric(10, 3), nullable=False, default=0, server_default="0"
    )
    carton_length_cm: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False, default=0, server_default="0"
    )
    carton_width_cm: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False, default=0, server_default="0"
    )
    carton_height_cm: Mapped[float] = mapped_column(
        Numeric(10, 2), nullable=False, default=0, server_default="0"
    )
    carton_weight_kg: Mapped[float] = mapped_column(
        Numeric(10, 3), nullable=False, default=0, server_default="0"
    )
    units_per_carton: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    currency: Mapped[str] = mapped_column(
        String, nullable=False, default="CNY", server_default="CNY"
    )
    country: Mapped[str] = mapped_column(
        String(2), nullable=False, default="US", server_default="US", index=True
    )
    sort_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1", index=True
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true", index=True
    )
    source_file: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

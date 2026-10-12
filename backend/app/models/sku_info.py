from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
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

if TYPE_CHECKING:
    from app.models.project import Project


class SkuRecord(Base):
    __tablename__ = "product_costs"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "sku",
            "asin",
            "country",
            name="product_costs_project_id_sku_asin_country_key",
        ),
        UniqueConstraint(
            "id", "project_id", "country",
            name="uq_product_costs_id_project_country",
        ),
        Index("idx_product_costs_project_id", "project_id"),
        Index("idx_product_costs_project_sort", "project_id", "sort_order", "id"),
        Index("idx_product_costs_project_sku_active", "project_id", "sku", "is_active"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="RESTRICT"),
        nullable=False,
    )
    project: Mapped["Project"] = relationship(back_populates="sku_records")
    # project_name is kept as a read-only denormalized field for historical queries.
    # Write operations must use project_id; this column is populated via triggers
    # or application-level sync (see sku_info_service).
    project_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    sku: Mapped[str] = mapped_column(String, nullable=False, index=True)
    asin: Mapped[str] = mapped_column(String, nullable=False, index=True)
    fnsku: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    product_name: Mapped[str | None] = mapped_column(String, nullable=True)
    father_id: Mapped[str | None] = mapped_column(String, nullable=True)
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
    sku_factory_info: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    sku_factory_info_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    sku_factory_info_updated_by: Mapped[str | None] = mapped_column(
        String, nullable=True
    )
    # ── 产品文案（Listing Copy，BLF-1080）─────────────────────────────
    # 亚马逊 Listing 文案字段组：标题 + 5 点描述（拆 5 列，便于导出成列与
    # 单点校验）+ Description + 卖点提炼；全部可空（未录入 = NULL）。
    # updated_{at,by} 对齐 sku_factory_info_updated_{at,by} 溯源先例。
    listing_title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    listing_bullet_1: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_2: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_3: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_4: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_bullet_5: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_selling_points: Mapped[str | None] = mapped_column(Text, nullable=True)
    listing_copy_updated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    listing_copy_updated_by: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )
    fnsku_label_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    fnsku_label_r2_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    product_image_r2_key: Mapped[str | None] = mapped_column(String(512), nullable=True)
    product_image_r2_url: Mapped[str | None] = mapped_column(
        String(1024), nullable=True
    )
    product_image_thumbnail_r2_key: Mapped[str | None] = mapped_column(
        String(512), nullable=True
    )
    product_image_thumbnail_r2_url: Mapped[str | None] = mapped_column(
        String(1024), nullable=True
    )
    product_image_uploaded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    product_image_uploaded_by: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

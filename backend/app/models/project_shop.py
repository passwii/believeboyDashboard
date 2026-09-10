from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    UniqueConstraint,
    func,
)


from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base

if TYPE_CHECKING:
    from app.models.project import Project


class ProjectShop(Base):
    """Persistent mapping between a project/country and a real shop id.

    BLF-1022: ``shop_name`` is the KJVS preferred launch parameter (unique
    name resolution value); ``shop_id`` stays the stable primary key.
    ``seller_identity_*`` keeps the Seller Central account-switcher alias
   对照 so agents can verify page identity before reading/writing complaints.
    """

    __tablename__ = "project_shops"
    __table_args__ = (
        CheckConstraint(
            "country in ('US', 'DE', 'UK')", name="ck_project_shops_country"
        ),
        CheckConstraint(
            "length(trim(shop_id)) > 0", name="ck_project_shops_shop_id_nonempty"
        ),
        UniqueConstraint(
            "project_id", "country", name="uq_project_shops_project_country"
        ),
        UniqueConstraint("shop_id", name="uq_project_shops_shop_id"),
        UniqueConstraint("shop_name", name="uq_project_shops_shop_name"),
        Index("idx_project_shops_project_country", "project_id", "country"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    shop_id: Mapped[str] = mapped_column(String(64), nullable=False)
    shop_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    seller_identity_expected_alias: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )
    seller_identity_aliases: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default="[]", default=list
    )
    seller_identity_source: Mapped[str | None] = mapped_column(
        String(128), nullable=True
    )
    seller_identity_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="1", default=True
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

    project: Mapped["Project"] = relationship(back_populates="shops")

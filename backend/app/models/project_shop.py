from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)


from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base

if TYPE_CHECKING:
    from app.models.project import Project


class ProjectShop(Base):
    """Persistent mapping between a project/country and a real shop id."""

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

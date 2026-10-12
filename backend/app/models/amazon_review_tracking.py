from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AmazonReviewGroup(Base):
    __tablename__ = "amazon_review_groups"
    __table_args__ = (
        UniqueConstraint(
            "id", "project_id", "marketplace",
            name="uq_amazon_review_groups_member_ref",
        ),
        ForeignKeyConstraint(
            ["representative_sku_record_id", "project_id", "marketplace"],
            ["product_costs.id", "product_costs.project_id", "product_costs.country"],
            ondelete="RESTRICT",
        ),
        Index("idx_amazon_review_groups_scope_active", "project_id", "marketplace", "is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    representative_sku_record_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewGroupMember(Base):
    __tablename__ = "amazon_review_group_members"
    __table_args__ = (
        ForeignKeyConstraint(
            ["group_id", "project_id", "marketplace"],
            ["amazon_review_groups.id", "amazon_review_groups.project_id", "amazon_review_groups.marketplace"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["sku_record_id", "project_id", "marketplace"],
            ["product_costs.id", "product_costs.project_id", "product_costs.country"],
            ondelete="RESTRICT",
        ),
        Index(
            "uq_amazon_review_group_members_active_sku",
            "sku_record_id",
            unique=True,
            postgresql_where=text("removed_at IS NULL"),
            sqlite_where=text("removed_at IS NULL"),
        ),
        Index("idx_amazon_review_group_members_group_active", "group_id", "removed_at"),
        Index("idx_amazon_review_group_members_sku", "sku_record_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    sku_record_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

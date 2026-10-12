from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class AmazonReviewGroup(Base):
    __tablename__ = "amazon_review_groups"
    __table_args__ = (
        Index("idx_amazon_review_groups_scope_active", "project_id", "marketplace", "is_active"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    representative_sku_record_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("product_costs.id", ondelete="RESTRICT"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="true")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())


class AmazonReviewGroupMember(Base):
    __tablename__ = "amazon_review_group_members"
    __table_args__ = (
        Index(
            "uq_amazon_review_group_members_active_sku",
            "project_id", "marketplace", "sku_record_id",
            unique=True,
            postgresql_where=text("removed_at IS NULL"),
            sqlite_where=text("removed_at IS NULL"),
        ),
        Index("idx_amazon_review_group_members_group_active", "group_id", "removed_at"),
        Index("idx_amazon_review_group_members_sku", "sku_record_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[int] = mapped_column(Integer, ForeignKey("amazon_review_groups.id", ondelete="RESTRICT"), nullable=False)
    project_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False)
    marketplace: Mapped[str] = mapped_column(String(2), nullable=False)
    sku_record_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("product_costs.id", ondelete="RESTRICT"), nullable=False)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

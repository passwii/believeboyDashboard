"""用户对发货批次下拉的隐藏偏好。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class ShipmentBatchDropdownHidden(Base):
    __tablename__ = "shipment_batch_dropdown_hidden"
    __table_args__ = (
        UniqueConstraint(
            "operator",
            "project_id",
            "country",
            "shipment_batch",
            name="uq_shipment_batch_dropdown_hidden_scope",
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    operator: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    country: Mapped[str] = mapped_column(String(8), nullable=False)
    shipment_batch: Mapped[str] = mapped_column(String(100), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

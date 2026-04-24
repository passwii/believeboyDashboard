from datetime import datetime
from typing import Optional

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ReturnAnalysisRecord(Base):
    """退货记录主表"""

    __tablename__ = "return_analysis_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    country: Mapped[str] = mapped_column(String(10), nullable=False, default="US")
    # 转换后的日期（美国时间）
    return_date: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    # 原始订单信息
    order_id: Mapped[str] = mapped_column(String(50), nullable=False)
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    asin: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    fnsku: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    product_name: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    fulfillment_center_id: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # 原始状态值
    detailed_disposition: Mapped[str] = mapped_column(String(50), nullable=False)
    reason: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(100), nullable=False)
    license_plate_number: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    # 原始ISO时间戳
    original_return_datetime: Mapped[str] = mapped_column(String(30), nullable=False)
    # 是否当前版本
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # 关联顾客评论
    comments: Mapped[list["ReturnCustomerComment"]] = relationship(
        "ReturnCustomerComment",
        back_populates="return_record",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "country",
            "order_id",
            "sku",
            "original_return_datetime",
            "license_plate_number",
            name="uq_return_record_key",
        ),
        Index("idx_return_analysis_project_date", "project_id", "return_date"),
    )


class ReturnCustomerComment(Base):
    """顾客评论独立表 - 存储非标准化的顾客评论"""

    __tablename__ = "return_customer_comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    return_record_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("return_analysis_records.id", ondelete="CASCADE"), nullable=False
    )
    sku: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    order_id: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    # 原始评论内容（可能包含pipe分隔的多条评论）
    customer_comment: Mapped[Text] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=datetime.utcnow
    )

    # 关联退货记录
    return_record: Mapped["ReturnAnalysisRecord"] = relationship(
        "ReturnAnalysisRecord", back_populates="comments"
    )

    __table_args__ = (
        Index("idx_customer_comments_sku_order", "sku", "order_id"),
    )

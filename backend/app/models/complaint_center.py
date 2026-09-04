"""客诉中心模型（BLF-981）：complaint_runs / shop_checks / complaints。

Agent 每天巡检 15 家 Amazon 店铺买家消息，提取「待回复客诉」明细写入。
一次巡检 = 一个 run；每个店铺一条 shop_check；每个待回复消息一条 complaint。
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class ComplaintRun(Base):
    """一次巡检 run。"""

    __tablename__ = 'complaint_runs'
    __table_args__ = (
        UniqueConstraint('run_date', name='uq_complaint_runs_run_date'),
        Index('idx_complaint_runs_run_date', 'run_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    run_date: Mapped[date] = mapped_column(Date(), nullable=False)
    trigger: Mapped[str] = mapped_column(String(16), nullable=False, server_default='autopilot')
    shops_total: Mapped[int] = mapped_column(Integer(), nullable=False, server_default='0')
    shops_checked: Mapped[int] = mapped_column(Integer(), nullable=False, server_default='0')
    shops_failed: Mapped[list] = mapped_column(JSON(), nullable=False, server_default='[]')
    summary: Mapped[dict] = mapped_column(JSON(), nullable=False, server_default='{}')
    agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    shop_checks: Mapped[list['ShopCheck']] = relationship(
        back_populates='run', cascade='all, delete-orphan', passive_deletes=True,
    )
    complaints: Mapped[list['Complaint']] = relationship(
        back_populates='run', cascade='all, delete-orphan', passive_deletes=True,
    )


class ShopCheck(Base):
    """单店检查结果。"""

    __tablename__ = 'shop_checks'
    __table_args__ = (
        UniqueConstraint('run_id', 'shop_id', name='uq_shop_checks_run_shop'),
        Index('idx_shop_checks_run_id', 'run_id'),
        Index('idx_shop_checks_shop_id', 'shop_id'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    run_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        ForeignKey('complaint_runs.id', ondelete='CASCADE'),
        nullable=False,
    )
    shop_id: Mapped[str] = mapped_column(String(64), nullable=False)
    shop_name: Mapped[str] = mapped_column(String(128), nullable=False)
    site: Mapped[str] = mapped_column(String(2), nullable=False, server_default='US')
    seller_identity: Mapped[str | None] = mapped_column(String(128), nullable=True)
    check_status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='ok')
    error_message: Mapped[str | None] = mapped_column(Text(), nullable=True)
    metrics: Mapped[dict] = mapped_column(JSON(), nullable=False, server_default='{}')
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    run: Mapped[ComplaintRun] = relationship(back_populates='shop_checks')


class Complaint(Base):
    """客诉明细。

    自然键幂等（has_order 区分）：
    - 有订单：(shop_id, buyer_name, message_date)
    - 无订单：(shop_id, buyer_name, message_date, subject)
    """

    __tablename__ = 'complaints'
    __table_args__ = (
        Index('idx_complaints_run_id', 'run_id'),
        Index('idx_complaints_shop_id', 'shop_id'),
        Index('idx_complaints_status', 'status'),
        Index('idx_complaints_category', 'category'),
        Index('idx_complaints_message_date', 'message_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    run_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        ForeignKey('complaint_runs.id', ondelete='CASCADE'),
        nullable=False,
    )
    shop_id: Mapped[str] = mapped_column(String(64), nullable=False)
    shop_name: Mapped[str] = mapped_column(String(128), nullable=False)
    site: Mapped[str] = mapped_column(String(2), nullable=False, server_default='US')
    buyer_name: Mapped[str] = mapped_column(String(255), nullable=False)
    message_date: Mapped[date] = mapped_column(Date(), nullable=False)
    subject: Mapped[str] = mapped_column(String(512), nullable=False)
    message_body: Mapped[str] = mapped_column(Text(), nullable=False)
    triage: Mapped[dict] = mapped_column(JSON(), nullable=False, server_default='{}')
    category: Mapped[str] = mapped_column(String(16), nullable=False, server_default='no_order_info')
    has_order: Mapped[bool] = mapped_column(Boolean(), nullable=False, server_default='0')
    order_info: Mapped[dict | None] = mapped_column(JSON(), nullable=True)
    sla: Mapped[dict | None] = mapped_column(JSON(), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default='pending')
    draft_path: Mapped[str | None] = mapped_column(Text(), nullable=True)
    reply_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    handler_note: Mapped[str | None] = mapped_column(Text(), nullable=True)
    status_history: Mapped[list] = mapped_column(JSON(), nullable=False, server_default='[]')
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    run: Mapped[ComplaintRun] = relationship(back_populates='complaints')

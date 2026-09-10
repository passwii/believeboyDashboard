"""客诉中心模型（BLF-981）：complaint_runs / shop_checks / complaints。

Agent 每天巡检项目的 Amazon 店铺买家消息，提取「待回复客诉」明细写入。
一次巡检 = 一个 run；每个项目每条 shop_check；每个待回复消息一条 complaint。

对齐 inventory/shipments 模式：用 project_id + country 标识店铺。
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
    """单店检查结果（按 project_id + country 标识）。

    BLF-1022: ``identity_*`` 随行留存 Seller Central 账户切换器观测值，
    便于追溯串店（verified 仅当 observed alias 精确命中期望/别名且
    observed_country 包含目标 country）。
    """

    __tablename__ = 'shop_checks'
    __table_args__ = (
        UniqueConstraint('run_id', 'project_id', 'country', name='uq_shop_checks_run_project_country'),
        Index('idx_shop_checks_run_id', 'run_id'),
        Index('idx_shop_checks_project', 'project_id'),
        Index('idx_shop_checks_project_country', 'project_id', 'country'),
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
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, server_default='US')
    check_status: Mapped[str] = mapped_column(String(32), nullable=False, server_default='ok')
    error_message: Mapped[str | None] = mapped_column(Text(), nullable=True)
    metrics: Mapped[dict] = mapped_column(JSON(), nullable=False, server_default='{}')
    identity_expected_alias: Mapped[str | None] = mapped_column(String(128), nullable=True)
    identity_observed_alias: Mapped[str | None] = mapped_column(String(128), nullable=True)
    identity_observed_country: Mapped[list] = mapped_column(JSON(), nullable=False, server_default='[]', default=list)
    identity_verified: Mapped[bool | None] = mapped_column(Boolean(), nullable=True)
    identity_source: Mapped[str | None] = mapped_column(String(128), nullable=True)
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
    - 有订单：(project_id, country, buyer_name, message_date)
    - 无订单：(project_id, country, buyer_name, message_date, subject)
    """

    __tablename__ = 'complaints'
    __table_args__ = (
        Index('idx_complaints_run_id', 'run_id'),
        Index('idx_complaints_project', 'project_id'),
        Index('idx_complaints_project_country', 'project_id', 'country'),
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
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer(), 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    country: Mapped[str] = mapped_column(String(2), nullable=False, server_default='US')
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
    first_message_date: Mapped[date] = mapped_column(Date(), nullable=False)
    message_count: Mapped[int] = mapped_column(Integer(), nullable=False, server_default='1')
    messages: Mapped[list] = mapped_column(JSON(), nullable=False, server_default='[]')
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )

    run: Mapped[ComplaintRun] = relationship(back_populates='complaints')

"""CRM domain models (customer / contact / lead / opportunity / follow)."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class CrmCustomerStatus(str):
    ACTIVE = "active"
    LOST = "lost"
    SIGNED = "signed"
    ON_HOLD = "on_hold"


class CrmCustomerRating(str):
    A = "A"
    B = "B"
    C = "C"
    D = "D"


class CrmCustomerSource(str):
    REFERRAL = "referral"
    EXHIBITION = "exhibition"
    ONLINE_AD = "online_ad"
    COLD_CALL = "cold_call"
    OTHER = "other"


class CrmLeadStatus(str):
    NEW = "new"
    CONTACTING = "contacting"
    QUALIFIED = "qualified"
    CONVERTED = "converted"
    DISCARDED = "discarded"


class CrmLeadIntent(str):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class CrmOpportunityStage(str):
    LEAD_IN = "lead_in"
    QUALIFIED = "qualified"
    PROPOSAL = "proposal"
    NEGOTIATION = "negotiation"
    WON = "won"
    LOST = "lost"


class CrmFollowType(str):
    PHONE = "phone"
    VISIT = "visit"
    WECHAT = "wechat"
    EMAIL = "email"
    NOTE = "note"


class CrmFollowEntityType(str):
    CUSTOMER = "customer"
    LEAD = "lead"
    OPPORTUNITY = "opportunity"


class CrmCustomer(Base):
    __tablename__ = "crm_customers"
    __table_args__ = (
        Index("idx_cc_owner", "owner_id"),
        Index("idx_cc_status_rating", "status", "rating"),
        Index("idx_cc_last_follow", "last_follow_at"),
        Index("idx_cc_next_follow", "next_follow_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    short_name: Mapped[str | None] = mapped_column(String(100))
    industry: Mapped[str | None] = mapped_column(String(100))
    rating: Mapped[str] = mapped_column(String(2), nullable=False, default=CrmCustomerRating.C)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmCustomerStatus.ACTIVE)
    source: Mapped[str | None] = mapped_column(String(30))
    customer_type: Mapped[str | None] = mapped_column(String(20))  # 工厂/贸易商/同行/其他
    interested_service: Mapped[str | None] = mapped_column(String(30))  # 代运营/AI运营/运营服务/其他
    owner_id: Mapped[str | None] = mapped_column(String(36))  # null = 在公海；user_accounts.id UUID
    address: Mapped[str | None] = mapped_column(Text)
    website: Mapped[str | None] = mapped_column(String(300))
    annual_revenue: Mapped[float | None] = mapped_column(Numeric(16, 2))
    employee_count: Mapped[int | None] = mapped_column(Integer)
    remark: Mapped[str | None] = mapped_column(Text)
    last_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # 下次跟进时间（P2b 待跟进视图）
    created_by: Mapped[str | None] = mapped_column(String(36))
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmContact(Base):
    __tablename__ = "crm_contacts"
    __table_args__ = (Index("idx_ctc_customer", "customer_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("crm_customers.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))
    wechat: Mapped[str | None] = mapped_column(String(100))
    title: Mapped[str | None] = mapped_column(String(100))  # 职务
    is_primary: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    remark: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmLead(Base):
    __tablename__ = "crm_leads"
    __table_args__ = (
        Index("idx_cl_owner", "owner_id"),
        Index("idx_cl_status_intent", "status", "intent"),
        Index("idx_cl_next_follow", "next_follow_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)  # 联系人名
    company: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50))
    email: Mapped[str | None] = mapped_column(String(200))
    wechat: Mapped[str | None] = mapped_column(String(100))
    source: Mapped[str | None] = mapped_column(String(30))
    customer_type: Mapped[str | None] = mapped_column(String(20))  # 工厂/贸易商/同行/其他
    interested_service: Mapped[str | None] = mapped_column(String(30))  # 代运营/AI运营/运营服务/其他
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmLeadStatus.NEW)
    intent: Mapped[str] = mapped_column(String(10), nullable=False, default=CrmLeadIntent.MEDIUM)
    owner_id: Mapped[str | None] = mapped_column(String(36))  # null = 在线索池；user_accounts.id UUID
    expected_amount: Mapped[float | None] = mapped_column(Numeric(16, 2))
    expected_close_date: Mapped[str | None] = mapped_column(String(10))  # YYYY-MM-DD
    remark: Mapped[str | None] = mapped_column(Text)
    next_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # 下次跟进时间（P2b 待跟进视图）
    converted_to_customer_id: Mapped[int | None] = mapped_column(Integer)
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(String(36))
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmOpportunity(Base):
    __tablename__ = "crm_opportunities"
    __table_args__ = (
        Index("idx_co_customer", "customer_id"),
        Index("idx_co_owner_stage", "owner_id", "stage"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("crm_customers.id", ondelete="SET NULL"), nullable=True
    )
    amount: Mapped[float] = mapped_column(Numeric(16, 2), nullable=False, default=0)
    stage: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmOpportunityStage.LEAD_IN)
    owner_id: Mapped[str | None] = mapped_column(String(36))  # user_accounts.id UUID
    expected_close_date: Mapped[str | None] = mapped_column(String(10))
    probability: Mapped[int | None] = mapped_column(Integer)  # 0-100
    linked_project_id: Mapped[int | None] = mapped_column(Integer)  # L3 挂接点（commission project，P5+）
    remark: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(36))
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class CrmFollow(Base):
    __tablename__ = "crm_follows"
    __table_args__ = (
        Index("idx_cf_entity", "entity_type", "entity_id"),
        Index("idx_cf_next", "next_follow_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False)
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(String(20), nullable=False, default=CrmFollowType.NOTE)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    next_follow_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[str | None] = mapped_column(String(36))  # user_accounts.id UUID
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class CrmAuditLog(Base):
    """CRM 操作审计日志（P4）：记录谁对实体做了什么。actor_id=null 表示系统操作。"""
    __tablename__ = "crm_audit_logs"
    __table_args__ = (
        Index("idx_cal_entity", "entity_type", "entity_id"),
        Index("idx_cal_actor", "actor_id"),
        Index("idx_cal_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(String(20), nullable=False)  # customer/lead/contact
    entity_id: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(30), nullable=False)  # create/update/delete/transfer/move_sea/claim/convert/set_primary
    actor_id: Mapped[str | None] = mapped_column(String(36))  # user_accounts.id UUID；null=系统
    summary: Mapped[str | None] = mapped_column(Text)  # 中文变更摘要
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

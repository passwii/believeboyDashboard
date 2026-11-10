"""意向客户工作台（crm_intent）模型。

与 Alembic 285 迁移保持一致的只读/可读 ORM 映射；Go Gateway 独占 crm_intent 路由，
FastAPI 不实现该域接口，模型仅用于同库读取与运维脚本。
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
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
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class CrmIntentBatchSource(str):
    AI = "ai"
    MANUAL = "manual"


class CrmIntentBatchStatus(str):
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class CrmIntentLevel(str):
    A = "A"
    B = "B"
    C = "C"
    D = "D"


class CrmIntentFollowupState(str):
    NONE = "none"
    CONTACTED = "contacted"
    WECHAT = "wechat"
    QUOTED = "quoted"
    NEGOTIATING = "negotiating"
    WON = "won"
    HOLD = "hold"
    MISMATCH = "mismatch"


class CrmIntentPhoneSource(str):
    LIST = "list"
    MANUAL = "manual"
    AI = "ai"


class CrmIntentPoolStatus(str):
    PENDING = "pending"
    SCREENED = "screened"
    IGNORED = "ignored"


class CrmIntentBatch(Base):
    __tablename__ = "crm_intent_batches"
    __table_args__ = (
        CheckConstraint(
            "source IN ('ai','manual')", name="ck_crm_intent_batches_source"
        ),
        CheckConstraint(
            "status IN ('processing','completed','failed')",
            name="ck_crm_intent_batches_status",
        ),
        Index("idx_crm_intent_batches_date", "batch_date"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_date: Mapped[date] = mapped_column(Date(), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    source_file_name: Mapped[str | None] = mapped_column(String(255))
    r2_key: Mapped[str | None] = mapped_column(String(1024))
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    result_json: Mapped[dict] = mapped_column(
        JSON, nullable=False, server_default="{}"
    )
    total_companies: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    total_pool: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    updated_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    skipped_locked_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    rejected_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=CrmIntentBatchStatus.PROCESSING
    )
    error_detail: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CrmIntentCompany(Base):
    __tablename__ = "crm_intent_companies"
    __table_args__ = (
        CheckConstraint(
            "intent_level IN ('A','B','C','D')",
            name="ck_crm_intent_companies_level",
        ),
        CheckConstraint(
            "intent_score IS NULL OR (intent_score >= 0 AND intent_score <= 100)",
            name="ck_crm_intent_companies_score",
        ),
        Index(
            "uq_crm_intent_companies_credit_code",
            "credit_code",
            unique=True,
            postgresql_where=__import__("sqlalchemy").text(
                "credit_code IS NOT NULL AND credit_code <> ''"
            ),
        ),
        Index("uq_crm_intent_companies_name_key", "name_key", unique=True),
        Index("idx_crm_intent_companies_owner", "owner_id"),
        Index("idx_crm_intent_companies_level", "intent_level"),
        Index("idx_crm_intent_companies_category", "category"),
        Index("idx_crm_intent_companies_region", "province", "city"),
        Index("idx_crm_intent_companies_screened", "screened_at"),
        Index("idx_crm_intent_companies_updated", "updated_at"),
        Index("idx_crm_intent_companies_touched", "human_touched_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("crm_intent_batches.id", ondelete="SET NULL")
    )
    external_id: Mapped[str | None] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    name_key: Mapped[str] = mapped_column(String(200), nullable=False)
    credit_code: Mapped[str | None] = mapped_column(String(32))
    legal_person: Mapped[str | None] = mapped_column(String(100))
    province: Mapped[str | None] = mapped_column(String(50))
    city: Mapped[str | None] = mapped_column(String(50))
    founded_year: Mapped[int | None] = mapped_column(Integer)
    registered_capital_wan: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    products: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(50))
    channel: Mapped[str | None] = mapped_column(String(50))
    channels: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default="[]"
    )
    channel_source: Mapped[str | None] = mapped_column(String(255))
    trademarks: Mapped[list] = mapped_column(
        JSON, nullable=False, server_default="[]"
    )
    trademark_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    intent_level: Mapped[str] = mapped_column(
        String(1), nullable=False, server_default=CrmIntentLevel.D
    )
    intent_score: Mapped[int | None] = mapped_column(Integer)
    intent_basis: Mapped[str | None] = mapped_column(Text)
    amazon_fit: Mapped[str | None] = mapped_column(Text)
    walmart_fit: Mapped[str | None] = mapped_column(Text)
    sources: Mapped[list] = mapped_column(JSON, nullable=False, server_default="[]")
    risks: Mapped[str | None] = mapped_column(Text)
    screened_at: Mapped[date | None] = mapped_column(Date())
    phone_note: Mapped[str | None] = mapped_column(Text)
    owner_id: Mapped[str | None] = mapped_column(String(36))
    human_touched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    human_touched_by: Mapped[str | None] = mapped_column(String(36))
    converted_customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("crm_customers.id", ondelete="SET NULL")
    )
    converted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CrmIntentPool(Base):
    __tablename__ = "crm_intent_pool"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending','screened','ignored')",
            name="ck_crm_intent_pool_status",
        ),
        Index("idx_crm_intent_pool_status", "status"),
        Index("idx_crm_intent_pool_batch", "batch_id"),
        Index("uq_crm_intent_pool_name_key", "name_key", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("crm_intent_batches.id", ondelete="SET NULL")
    )
    external_id: Mapped[str | None] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    name_key: Mapped[str] = mapped_column(String(200), nullable=False)
    legal_person: Mapped[str | None] = mapped_column(String(100))
    website: Mapped[str | None] = mapped_column(String(300))
    channel: Mapped[str | None] = mapped_column(String(50))
    channels: Mapped[list] = mapped_column(JSON, nullable=False, server_default="[]")
    channel_source: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=CrmIntentPoolStatus.PENDING
    )
    screened_company_id: Mapped[int | None] = mapped_column(
        ForeignKey("crm_intent_companies.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CrmIntentPhone(Base):
    __tablename__ = "crm_intent_phones"
    __table_args__ = (
        CheckConstraint(
            "source IN ('list','manual','ai')", name="ck_crm_intent_phones_source"
        ),
        CheckConstraint(
            "(CASE WHEN company_id IS NOT NULL THEN 1 ELSE 0 END) "
            "+ (CASE WHEN pool_id IS NOT NULL THEN 1 ELSE 0 END) = 1",
            name="ck_crm_intent_phones_owner",
        ),
        Index("idx_crm_intent_phones_normalized", "phone_normalized"),
        Index(
            "uq_crm_intent_phones_company_phone",
            "company_id",
            "phone_normalized",
            unique=True,
            postgresql_where=__import__("sqlalchemy").text("company_id IS NOT NULL"),
        ),
        Index(
            "uq_crm_intent_phones_pool_phone",
            "pool_id",
            "phone_normalized",
            unique=True,
            postgresql_where=__import__("sqlalchemy").text("pool_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id: Mapped[int | None] = mapped_column(
        ForeignKey("crm_intent_companies.id", ondelete="CASCADE")
    )
    pool_id: Mapped[int | None] = mapped_column(
        ForeignKey("crm_intent_pool.id", ondelete="CASCADE")
    )
    phone_raw: Mapped[str] = mapped_column(String(50), nullable=False)
    phone_normalized: Mapped[str] = mapped_column(String(32), nullable=False)
    source: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=CrmIntentPhoneSource.LIST
    )
    is_valid: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    created_by: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CrmIntentFollowup(Base):
    __tablename__ = "crm_intent_followups"
    __table_args__ = (
        CheckConstraint(
            "state IN ('none','contacted','wechat','quoted','negotiating',"
            "'won','hold','mismatch')",
            name="ck_crm_intent_followups_state",
        ),
        Index("idx_crm_intent_followups_next", "next_contact_at"),
    )

    company_id: Mapped[int] = mapped_column(
        ForeignKey("crm_intent_companies.id", ondelete="CASCADE"),
        primary_key=True,
    )
    state: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=CrmIntentFollowupState.NONE
    )
    note: Mapped[str] = mapped_column(Text, nullable=False, server_default="''")
    last_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1")
    updated_by: Mapped[str | None] = mapped_column(String(36))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CrmIntentFollowupEvent(Base):
    __tablename__ = "crm_intent_followup_events"
    __table_args__ = (
        Index("idx_crm_intent_followup_events_company", "company_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    company_id: Mapped[int] = mapped_column(
        ForeignKey("crm_intent_companies.id", ondelete="CASCADE"), nullable=False
    )
    from_state: Mapped[str | None] = mapped_column(String(20))
    to_state: Mapped[str | None] = mapped_column(String(20))
    note_snapshot: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CrmIntentImportRequest(Base):
    __tablename__ = "crm_intent_import_requests"
    __table_args__ = (
        CheckConstraint(
            "actor_kind IN ('agent','user')",
            name="ck_crm_intent_import_requests_actor_kind",
        ),
        UniqueConstraint(
            "actor_kind",
            "actor_id",
            "idempotency_key",
            name="uq_crm_intent_import_requests_key",
        ),
        Index("idx_crm_intent_import_requests_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    actor_kind: Mapped[str] = mapped_column(String(8), nullable=False)
    actor_id: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="processing"
    )
    response_json: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CrmIntentMeta(Base):
    __tablename__ = "crm_intent_meta"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_crm_intent_meta_single_row"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data_rev: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    followup_rev: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default="0"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

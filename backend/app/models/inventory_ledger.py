"""Inventory Ledger — Amazon Summary + Detailed 双视图模型 (BEL-428).

旧表 ``inventory_ledger_raw`` 暂留不动（用户决定：等新表稳定后单独迁移 drop），
新代码完全不读写它。三张新表：

1. ``InventoryLedgerIngestBatch`` —— 每次 CSV 上传的批次元数据
   （排查时按 batch 定位：哪天上传 / 谁上传 / 哪个文件 / 多少行 / 状态 / 对账结果）
2. ``InventoryLedgerSummary`` —— Summary 视图（22 列），真相源。
   1 行 = 1 个 (FNSKU × FC × Disposition × Date) 的水位快照，
   重复导入按 natural key upsert 幂等。
3. ``InventoryLedgerDetail`` —— Detailed 视图（16 列），事件级行。
   真实数据存在合法重复事件元组（同一天同一 SKU 多次同值事件），
   故不设事件元组唯一约束；去重落在批次表 file_hash 层。
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class InventoryLedgerIngestBatch(Base):
    """Metadata for one CSV ingest run. Each upload = 1 row here.

    Purpose:
    - 排查时按 batch 定位 (哪天上传 / 谁上传 / 哪个文件 / 哪个 project / 多少行 / 状态)
    - 多次上传去重 (同 (project_id, report_month, source_filename, file_hash) upsert)
    - audit 跟踪 (loaded_by / loaded_at / completed_at / error_message)
    """

    __tablename__ = "inventory_ledger_ingest_batch"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "report_month",
            "source_filename",
            "file_hash",
            name="uq_batch_natural_key",
        ),
        Index("ix_batch_project_month", "project_id", "report_month"),
        Index("ix_batch_loaded_at", "loaded_at"),
        Index("ix_batch_status", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    report_month: Mapped[date] = mapped_column(Date, nullable=False)
    # === 上传信息 ===
    source_filename: Mapped[str] = mapped_column(
        String(256), nullable=False, comment='如 "库存分类账-2026-07详细视图.csv"'
    )
    file_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # sha256 hex
    file_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    file_kind: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="unknown",
        comment="summary / detail / unknown (按列头自动识别)",
    )
    # === 上传者 ===
    # user_accounts.id 是 UUID，String(36) 存储、不建 FK（对齐 CRM owner_id 模式）
    loaded_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # === 执行结果 ===
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        server_default="pending",
        comment="pending / running / success / failed / partial",
    )
    rows_parsed: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    rows_written_summary: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    rows_written_detail: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    rows_skipped_duplicate: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    rows_failed_validation: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    error_message: Mapped[str | None] = mapped_column(Text)
    consistency_check: Mapped[str | None] = mapped_column(
        String(20), comment="ok / mismatch / not_run (跨表对账结果)"
    )
    consistency_mismatch_count: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )


class InventoryLedgerSummary(Base):
    """Amazon Inventory Ledger **Summary** view row (真相源).

    1 行 = 1 个 (FNSKU × FC × Disposition × Date) 的水位快照。
    22 列全部来自亚马逊 Summary CSV；natural key 与旧 raw 表相同，
    重复导入 upsert 幂等。
    """

    __tablename__ = "inventory_ledger_summary"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "report_month",
            "date",
            "msku",
            "disposition",
            "location",
            name="uq_ledger_summary_natural_key",
        ),
        Index("idx_summary_project_month", "project_id", "report_month"),
        Index(
            "idx_summary_project_month_msku",
            "project_id",
            "report_month",
            "msku",
        ),
        Index(
            "idx_summary_project_month_location",
            "project_id",
            "report_month",
            "location",
        ),
        Index("idx_summary_batch_id", "batch_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    report_month: Mapped[date] = mapped_column(
        Date, nullable=False, comment="YYYY-MM-01, ETL partition key"
    )
    batch_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("inventory_ledger_ingest_batch.id", ondelete="SET NULL"),
        nullable=True,
    )
    date: Mapped[date] = mapped_column(
        Date, nullable=False, comment="Business date from CSV"
    )
    fnsku: Mapped[str | None] = mapped_column(String(20), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(15), nullable=True)
    msku: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    disposition: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        comment="SELLABLE / CUSTOMER_DAMAGED / CARRIER_DAMAGED / WAREHOUSE_DAMAGED",
    )
    location: Mapped[str] = mapped_column(
        String(10), nullable=False, comment="FBA warehouse code"
    )
    starting_balance: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    in_transit_between: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    receipts: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    customer_shipments: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    customer_returns: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    vendor_returns: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    warehouse_transfer_io: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    found: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    lost: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    damaged: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    disposed: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    other_events: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    ending_balance: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    unknown_events: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    store: Mapped[str | None] = mapped_column(String(50), nullable=True)
    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class InventoryLedgerDetail(Base):
    """Amazon Inventory Ledger **Detailed** view row (事件级).

    1 行 = 1 个库存事件。16 列全部来自亚马逊 Detail CSV。

    无事件元组唯一约束：真实数据存在合法重复事件
    （同一天同一 SKU 同值事件多次出现），去重落在批次表 file_hash 层。
    """

    __tablename__ = "inventory_ledger_detail"
    __table_args__ = (
        Index("idx_detail_project_month", "project_id", "report_month"),
        Index(
            "idx_detail_project_month_msku",
            "project_id",
            "report_month",
            "msku",
        ),
        Index(
            "idx_detail_project_month_location",
            "project_id",
            "report_month",
            "fulfillment_center",
        ),
        Index("idx_detail_batch_id", "batch_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    report_month: Mapped[date] = mapped_column(
        Date, nullable=False, comment="YYYY-MM-01, ETL partition key"
    )
    batch_id: Mapped[int | None] = mapped_column(
        Integer,
        ForeignKey("inventory_ledger_ingest_batch.id", ondelete="SET NULL"),
        nullable=True,
    )
    date: Mapped[date] = mapped_column(
        Date, nullable=False, comment="Business date from CSV"
    )
    fnsku: Mapped[str | None] = mapped_column(String(20), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(15), nullable=True)
    msku: Mapped[str] = mapped_column(String(30), nullable=False)
    title: Mapped[str | None] = mapped_column(String(500), nullable=True)
    event_type: Mapped[str] = mapped_column(
        String(40),
        nullable=False,
        comment="Receipts / Shipments / WhseTransfers / CustomerReturns / VendorReturns / Adjustments",
    )
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    fulfillment_center: Mapped[str] = mapped_column(
        String(10), nullable=False, comment="FBA warehouse code"
    )
    disposition: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        comment="SELLABLE / CUSTOMER_DAMAGED / CARRIER_DAMAGED / WAREHOUSE_DAMAGED",
    )
    reason: Mapped[str | None] = mapped_column(String(20), nullable=True)
    country: Mapped[str | None] = mapped_column(String(10), nullable=True)
    reconciled_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unreconciled_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    date_and_time: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    store: Mapped[str | None] = mapped_column(String(50), nullable=True)
    loaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

"""Inventory Ledger raw rows — Amazon Detailed Inventory Ledger CSV ingest.

One row per (Date × MSKU × Location × Disposition) event from the monthly
CSV export.  Sparse ledger: Amazon only writes a row when the combination
changes, not every day.
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
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class InventoryLedgerRaw(Base):
    """Raw inventory ledger row from Amazon Detailed Inventory Ledger CSV."""

    __tablename__ = "inventory_ledger_raw"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "report_month",
            "date",
            "msku",
            "disposition",
            "location",
            name="uq_ledger_natural_key",
        ),
        Index("idx_ledger_project_month", "project_id", "report_month"),
        Index("idx_ledger_project_month_msku", "project_id", "report_month", "msku"),
        Index(
            "idx_ledger_project_month_location",
            "project_id",
            "report_month",
            "location",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
    )
    report_month: Mapped[date] = mapped_column(
        Date, nullable=False, comment="YYYY-MM-01, ETL partition key"
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
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

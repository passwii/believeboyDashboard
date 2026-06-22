from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class InventoryReplenishmentSnapshot(Base):
    """库存补货分析快照表

    存储补货分析计算结果的完整快照，支持版本管理和历史查看。

    唯一性约束：partial unique index ``(project_id, country) WHERE is_current = TRUE``
    由 Alembic 迁移 ``20260622_167`` 在 PostgreSQL/SQLite 双方言上创建。
    原 ``UniqueConstraint('project_id', 'country', 'snapshot_date')`` 已被该 partial unique
    替换——同一天同一项目可保留多张历史快照（按 ``created_at`` 排序），但"当前快照"每
    ``(project, country)`` 全局唯一。
    """
    __tablename__ = 'inventory_replenishment_snapshots'
    __table_args__ = (
        # Partial unique index: at most one current snapshot per (project, country).
        # The actual DDL is executed by the Alembic migration to keep PG/SQLite in sync.
        Index(
            'uq_inventory_replenishment_snapshots_current',
            'project_id', 'country',
            unique=True,
            postgresql_where=text('is_current IS TRUE'),
            sqlite_where=text('is_current = 1'),
        ),
        Index('idx_inventory_replenishment_snapshots_project_id', 'project_id'),
        Index('idx_inventory_replenishment_snapshots_project_country', 'project_id', 'country'),
        Index('idx_inventory_replenishment_snapshots_date', 'snapshot_date'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('projects.id', ondelete='CASCADE'),
        nullable=False,
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default='US', server_default='US')

    snapshot_date: Mapped[date] = mapped_column(Date(), nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default='false')

    inventory_report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    business_report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)
    sales_report_date: Mapped[date | None] = mapped_column(Date(), nullable=True)

    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(String(512), nullable=True)

    summary_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    row_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    computation_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())

    items: Mapped[list['InventoryReplenishmentSnapshotItem']] = relationship(
        back_populates='snapshot',
        cascade='all, delete-orphan',
    )


class InventoryReplenishmentSnapshotItem(Base):
    """库存补货分析快照明细表

    存储每个 SKU 的完整补货分析结果。
    """
    __tablename__ = 'inventory_replenishment_snapshot_items'
    __table_args__ = (
        Index('idx_inventory_replenishment_snapshot_items_snapshot_id', 'snapshot_id'),
        Index('idx_inventory_replenishment_snapshot_items_sku', 'snapshot_id', 'sku'),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    snapshot_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        ForeignKey('inventory_replenishment_snapshots.id', ondelete='CASCADE'),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(Integer, nullable=False)

    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)

    available_inventory: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')
    in_transit_quantity: Mapped[int] = mapped_column(Integer, nullable=False, server_default='0')

    dms_30: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    dms_14: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    dms_7: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    dms_3: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    base_dms: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)

    safety_factor: Mapped[Decimal] = mapped_column(Numeric(8, 4), nullable=False, server_default='0.20')
    production_lead_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default='20')
    shipping_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default='25')
    weighted_dms: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)

    sellable_days: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    sellout_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sellout_date_with_transit: Mapped[str | None] = mapped_column(String(32), nullable=True)
    replenishment_order_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    warehouse_entry_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    shipment_order_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    estimated_replenishment_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)

    risk_status: Mapped[str] = mapped_column(String(32), nullable=False)
    risk_anchor_date: Mapped[str | None] = mapped_column(String(32), nullable=True)

    snapshot: Mapped[InventoryReplenishmentSnapshot] = relationship(back_populates='items')
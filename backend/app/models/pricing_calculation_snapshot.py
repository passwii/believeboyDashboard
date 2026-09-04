from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    Numeric,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class PricingCalculationSnapshot(Base):
    """店铺定价历史快照主表

    区别于 ``NewProductCalculation``（2026-08-03 由 ``StoreSkuPricingSnapshot`` 改名，
    原表 ``store_sku_pricing_snapshots`` 迁移 230 已重命名为 ``new_product_calculations``；
    每个 project+sku 只有"最新一条"的当前态缓存），本表为 append-only 模式：每次用户点
    "保存为快照"会新增一行，历史可任意回放。

    字段对齐 shop-calculation 顶部 stat bar：

    - ``summary_json`` → ``{total, calculated, profitable, passRate}``

    国家维度 ``country`` 进入主表：US / DE / UK，同一项目可按站点分别保存。
    """

    __tablename__ = "pricing_calculation_snapshots"
    __table_args__ = (
        Index("idx_pricing_calculation_snapshots_project_id", "project_id"),
        Index(
            "idx_pricing_calculation_snapshots_project_country", "project_id", "country"
        ),
        Index("idx_pricing_calculation_snapshots_date", "snapshot_date"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    project_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)

    snapshot_date: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # {total, calculated, profitable, passRate}
    summary_json: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )

    row_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    items: Mapped[list["PricingCalculationSnapshotItem"]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
    )


class PricingCalculationSnapshotItem(Base):
    """店铺定价历史快照明细表

    镜像 ``NewProductCalculation``（原 ``StoreSkuPricingSnapshot``）全部业务列（含 US + EU 通用字段）：
    ``delivery_fee_usd`` / ``inbound_config_fee_manual_usd`` / ``storage_fee_manual_usd`` /
    ``vat_usd`` / ``profit_after_vat_*``。

    不加唯一约束 —— append-only，允许多份历史同 SKU 重复。
    """

    __tablename__ = "pricing_calculation_snapshot_items"
    __table_args__ = (
        Index("idx_pricing_calculation_snapshot_items_snapshot_id", "snapshot_id"),
        Index("idx_pricing_calculation_snapshot_items_sku", "snapshot_id", "sku"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    snapshot_id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        ForeignKey("pricing_calculation_snapshots.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_row_no: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )

    # 主键维度
    project_id: Mapped[int] = mapped_column(Integer, nullable=False)
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(2), nullable=True)
    calculation_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="profit_calc"
    )

    # 尺寸
    package_length_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    package_width_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    package_height_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    weight_kg: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    # 成本
    fob_product_cost_rmb: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False
    )
    first_leg_cost_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    ddp_cost_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    ddp_cost_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)

    # 销售参数
    sale_price_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    target_profit_rate: Mapped[Decimal | None] = mapped_column(
        Numeric(8, 6), nullable=True
    )
    advertising_rate: Mapped[Decimal] = mapped_column(
        Numeric(8, 6), nullable=False, server_default="0.120000"
    )
    return_loss_rate: Mapped[Decimal] = mapped_column(
        Numeric(8, 6), nullable=False, server_default="0.040000"
    )
    storage_months: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="1.00"
    )
    inbound_placement_mode: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="single_destination"
    )

    # 汇率
    usd_to_rmb_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    usd_to_rmb_rate_source: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=""
    )

    # 尺寸等级 / 售价带
    size_tier: Mapped[str] = mapped_column(String(32), nullable=False)
    size_tier_label: Mapped[str] = mapped_column(String(64), nullable=False)
    price_band: Mapped[str] = mapped_column(String(32), nullable=False)
    price_band_label: Mapped[str] = mapped_column(String(64), nullable=False)

    # 尺寸详情
    longest_side_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    middle_side_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    shortest_side_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    length_plus_girth_in: Mapped[Decimal] = mapped_column(
        Numeric(18, 4), nullable=False
    )
    volume_cubic_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    volume_cubic_ft: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)

    # 重量详情
    product_weight_lb: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    product_weight_oz: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    dimensional_weight_lb: Mapped[Decimal] = mapped_column(
        Numeric(18, 4), nullable=False
    )
    chargeable_weight_lb: Mapped[Decimal] = mapped_column(
        Numeric(18, 4), nullable=False
    )
    chargeable_weight_oz: Mapped[Decimal] = mapped_column(
        Numeric(18, 4), nullable=False
    )
    chargeable_weight_rule: Mapped[str] = mapped_column(String(64), nullable=False)

    # 费用规则标签
    fulfillment_fee_rule_label: Mapped[str] = mapped_column(String(128), nullable=False)
    inbound_config_fee_rule_label: Mapped[str] = mapped_column(
        String(128), nullable=False
    )
    storage_fee_rule_label: Mapped[str] = mapped_column(String(128), nullable=False)

    # 费用详情
    referral_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    advertising_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    return_loss_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    fba_fulfillment_fee_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False
    )
    inbound_config_fee_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False
    )
    storage_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    total_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    platform_fee_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, server_default="0.00"
    )
    # EU 手动填写费用
    delivery_fee_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, server_default="0.00"
    )
    inbound_config_fee_manual_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, server_default="0.00"
    )
    storage_fee_manual_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, server_default="0.00"
    )

    # 利润详情
    payout_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    profit_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    profit_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False)
    # EU VAT
    vat_usd: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, server_default="0.00"
    )
    profit_after_vat_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(18, 2), nullable=True
    )
    profit_after_vat_rate: Mapped[Decimal | None] = mapped_column(
        Numeric(8, 6), nullable=True
    )

    # 警告 / 备注
    warnings_json: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    snapshot: Mapped[PricingCalculationSnapshot] = relationship(back_populates="items")

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Integer, JSON, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class NewProductCalculation(Base):
    """新品核算表（2026-08-03 迁移 230 由 store_sku_pricing_snapshots 改名）

    用于存储新品维度的核算结果，支持：
    - 利润核算 (profit_calc)
    - 利润倒算 (profit_reverse)

    每个项目 + SKU + 核算类型只有一条最新记录（upsert 策略）。
    新表名 ``new_product_calculations`` 与前端"新品核算"功能语义对齐
    （历史命名 store-sku-pricing 是遗留问题，见 BEL-378）。
    """

    __tablename__ = "new_product_calculations"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    # 项目信息
    project_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    sku: Mapped[str] = mapped_column(String(128), nullable=False)
    asin: Mapped[str | None] = mapped_column(String(64), nullable=True)
    country: Mapped[str | None] = mapped_column(String(32), nullable=True)

    # 核算类型
    calculation_type: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="profit_calc"
    )

    # 尺寸信息
    package_length_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    package_width_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    package_height_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    weight_kg: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    # 成本信息
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
    )  # 仅用于倒算
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
    usd_to_rmb_rate_source: Mapped[str] = mapped_column(String(64), nullable=False)

    # 尺寸等级和售价带
    size_tier: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
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

    # 警告信息
    warnings_json: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    # 备注
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 操作人
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

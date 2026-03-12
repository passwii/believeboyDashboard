from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Integer, JSON, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class PricingCalculationRun(Base):
    __tablename__ = 'pricing_calculation_runs'

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, 'sqlite'),
        primary_key=True,
        autoincrement=True,
    )
    product_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)

    package_length_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    package_width_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    package_height_cm: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    weight_kg: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    fob_product_cost_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    first_leg_cost_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    ddp_cost_rmb: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    ddp_cost_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)

    sale_price_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    calculation_type: Mapped[str] = mapped_column(String(32), nullable=False, server_default='profit_calc')
    commission_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False, server_default='0.150000')
    advertising_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False, server_default='0.120000')
    return_loss_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False, server_default='0.040000')
    storage_months: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False, server_default='1.00')
    inbound_placement_mode: Mapped[str] = mapped_column(String(32), nullable=False, server_default='single_destination')

    usd_to_rmb_rate: Mapped[Decimal] = mapped_column(Numeric(18, 8), nullable=False)
    usd_to_rmb_rate_source: Mapped[str] = mapped_column(String(64), nullable=False)

    size_tier: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    size_tier_label: Mapped[str] = mapped_column(String(64), nullable=False)
    price_band: Mapped[str] = mapped_column(String(32), nullable=False)
    price_band_label: Mapped[str] = mapped_column(String(64), nullable=False)

    longest_side_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    middle_side_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    shortest_side_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    length_plus_girth_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    volume_cubic_in: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    volume_cubic_ft: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)

    product_weight_lb: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    product_weight_oz: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    dimensional_weight_lb: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    chargeable_weight_lb: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    chargeable_weight_oz: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    chargeable_weight_rule: Mapped[str] = mapped_column(String(64), nullable=False)

    fulfillment_fee_rule_label: Mapped[str] = mapped_column(String(128), nullable=False)
    inbound_config_fee_rule_label: Mapped[str] = mapped_column(String(128), nullable=False)
    storage_fee_rule_label: Mapped[str] = mapped_column(String(128), nullable=False)

    referral_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    advertising_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    return_loss_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    fba_fulfillment_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    inbound_config_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    storage_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    total_fee_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)

    payout_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    profit_usd: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    profit_rate: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False)

    warnings_json: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

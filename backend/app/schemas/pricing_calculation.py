from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

InboundPlacementMode = Literal["single_destination", "amazon_optimized_split"]
CalculationType = Literal["profit_calc", "profit_reverse", "cost_reverse", "fbm_calc", "eu_accounting"]


class PricingCalculationCreateRequest(BaseModel):
    country: str = Field(default="US", max_length=10)
    product_name: str = Field(min_length=1, max_length=255)
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)
    fob_product_cost_rmb: float = Field(ge=0, le=100000000)
    first_leg_cost_rmb: float = Field(ge=0, le=100000000)
    project_id: int | None = Field(default=None, gt=0)
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    use_historical_shipping_cost: bool = False
    sale_price_usd: float = Field(gt=0, le=100000000)
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    storage_months: float = Field(default=1, gt=0, le=120)
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)


class PricingCalculationReverseRequest(BaseModel):
    country: str = Field(default="US", max_length=10)
    product_name: str = Field(min_length=1, max_length=255)
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)
    fob_product_cost_rmb: float = Field(ge=0, le=100000000)
    first_leg_cost_rmb: float = Field(ge=0, le=100000000)
    project_id: int | None = Field(default=None, gt=0)
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    use_historical_shipping_cost: bool = False
    target_profit_rate: float = Field(default=0.25, ge=0, lt=1)
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    storage_months: float = Field(default=1, gt=0, le=120)
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)


class PricingCalculationCostReverseRequest(BaseModel):
    country: str = Field(default="US", max_length=10)
    product_name: str = Field(min_length=1, max_length=255)
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)
    first_leg_cost_rmb: float = Field(ge=0, le=100000000)
    project_id: int | None = Field(default=None, gt=0)
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    use_historical_shipping_cost: bool = False
    sale_price_usd: float = Field(gt=0, le=100000000)
    target_profit_rate: float = Field(default=0.25, ge=0, lt=1)
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    storage_months: float = Field(default=1, gt=0, le=120)
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)


class PricingCalculationFbmRequest(BaseModel):
    country: str = Field(default="US", max_length=10)
    product_name: str = Field(min_length=1, max_length=255)
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)
    fob_product_cost_rmb: float = Field(ge=0, le=100000000)
    full_container_quantity: float = Field(gt=0, le=100000)
    full_container_price_rmb: float = Field(ge=0, le=100000000)
    delivery_fee_usd: float = Field(ge=0, le=100000)
    project_id: int | None = Field(default=None, gt=0)
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    use_historical_shipping_cost: bool = False
    sale_price_usd: float = Field(gt=0, le=100000000)
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    storage_months: float = Field(default=1, gt=0, le=120)
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)


class PricingCalculationEURequest(BaseModel):
    """欧洲（德国/英国）店铺 SKU 核算请求"""
    country: Literal["DE", "UK"] = Field(description="德国(DE)或英国(UK)")
    product_name: str = Field(min_length=1, max_length=255)
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)
    fob_product_cost_rmb: float = Field(ge=0, le=100000000)
    first_leg_cost_rmb: float = Field(ge=0, le=100000000)
    project_id: int | None = Field(default=None, gt=0)
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    sale_price_usd: float = Field(gt=0, le=100000000)
    # 手动填写费用（默认0）
    delivery_fee_usd: float = Field(default=0.0, ge=0, le=100000, description="派送费(USD)，手动填写")
    inbound_config_fee_usd: float = Field(default=0.0, ge=0, le=100000, description="配置费(USD)，手动填写")
    storage_fee_usd: float = Field(default=0.0, ge=0, le=100000, description="仓储费(USD)，手动填写")
    # 其他费用参数
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)


class PricingCalculationDimensions(BaseModel):
    longest_side_in: float
    middle_side_in: float
    shortest_side_in: float
    length_plus_girth_in: float
    volume_cubic_in: float
    volume_cubic_ft: float


class PricingCalculationWeight(BaseModel):
    product_weight_lb: float
    product_weight_oz: float
    dimensional_weight_lb: float
    chargeable_weight_lb: float
    chargeable_weight_oz: float
    chargeable_weight_rule: str


class PricingCalculationFees(BaseModel):
    referral_fee_usd: float
    advertising_fee_usd: float
    return_loss_usd: float
    fba_fulfillment_fee_usd: float
    inbound_config_fee_usd: float
    storage_fee_usd: float
    total_fee_usd: float


class PricingCalculationProfit(BaseModel):
    ddp_cost_rmb: float
    ddp_cost_usd: float
    payout_usd: float
    profit_usd: float
    profit_rate: float
    vat_usd: float = 0.0
    profit_after_vat_usd: float | None = None
    profit_after_vat_rate: float | None = None


class PricingCalculationRunItem(BaseModel):
    id: int
    country: str = "US"
    product_name: str
    calculation_type: CalculationType = "profit_calc"
    project_id: int | None = None
    sku: str | None = None
    package_length_cm: float
    package_width_cm: float
    package_height_cm: float
    weight_kg: float
    fob_product_cost_rmb: float
    first_leg_cost_rmb: float
    sale_price_usd: float
    commission_rate: float
    advertising_rate: float
    return_loss_rate: float
    storage_months: float
    inbound_placement_mode: InboundPlacementMode
    size_tier: str
    size_tier_label: str
    price_band: str
    price_band_label: str
    usd_to_rmb_rate: float
    usd_to_rmb_rate_source: str
    fulfillment_fee_rule_label: str
    inbound_config_fee_rule_label: str
    storage_fee_rule_label: str
    dimensions: PricingCalculationDimensions
    weights: PricingCalculationWeight
    fees: PricingCalculationFees
    profit: PricingCalculationProfit
    warnings: list[str] = Field(default_factory=list)
    created_by: str | None = None
    created_at: str
    updated_at: str


class PricingCalculationRunListResponse(BaseModel):
    items: list[PricingCalculationRunItem]
    total: int
    page: int
    page_size: int

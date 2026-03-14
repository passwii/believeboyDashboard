from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


InboundPlacementMode = Literal['single_destination', 'amazon_optimized_split']
CalculationType = Literal['profit_calc', 'profit_reverse']


class StoreSkuPricingDimensions(BaseModel):
    longest_side_in: float
    middle_side_in: float
    shortest_side_in: float
    length_plus_girth_in: float
    volume_cubic_in: float
    volume_cubic_ft: float


class StoreSkuPricingWeight(BaseModel):
    product_weight_lb: float
    product_weight_oz: float
    dimensional_weight_lb: float
    chargeable_weight_lb: float
    chargeable_weight_oz: float
    chargeable_weight_rule: str


class StoreSkuPricingFees(BaseModel):
    referral_fee_usd: float
    advertising_fee_usd: float
    return_loss_usd: float
    fba_fulfillment_fee_usd: float
    inbound_config_fee_usd: float
    storage_fee_usd: float
    total_fee_usd: float


class StoreSkuPricingProfit(BaseModel):
    ddp_cost_rmb: float
    ddp_cost_usd: float
    payout_usd: float
    profit_usd: float
    profit_rate: float


class StoreSkuPricingSnapshotItem(BaseModel):
    """店铺 SKU 核算快照详情"""
    id: int
    project_id: int
    project_name: str
    sku: str
    asin: str | None = None
    country: str | None = None
    calculation_type: CalculationType = 'profit_calc'
    
    # 尺寸信息
    package_length_cm: float
    package_width_cm: float
    package_height_cm: float
    weight_kg: float
    
    # 成本信息
    fob_product_cost_rmb: float
    first_leg_cost_rmb: float
    ddp_cost_rmb: float
    ddp_cost_usd: float
    
    # 销售参数
    sale_price_usd: float
    target_profit_rate: float | None = None
    advertising_rate: float
    return_loss_rate: float
    storage_months: float
    inbound_placement_mode: InboundPlacementMode
    
    # 汇率
    usd_to_rmb_rate: float
    usd_to_rmb_rate_source: str
    
    # 尺寸等级和售价带
    size_tier: str
    size_tier_label: str
    price_band: str
    price_band_label: str
    
    # 尺寸详情
    dimensions: StoreSkuPricingDimensions
    # 重量详情
    weights: StoreSkuPricingWeight
    # 费用详情
    fees: StoreSkuPricingFees
    # 利润详情
    profit: StoreSkuPricingProfit
    
    # 警告信息
    warnings: list[str] = Field(default_factory=list)
    # 备注
    notes: str | None = None
    # 操作人
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime


class StoreSkuPricingSnapshotCreateRequest(BaseModel):
    """创建/更新店铺 SKU 核算快照的请求"""
    project_id: int
    project_name: str
    sku: str
    asin: str | None = None
    country: str | None = None
    calculation_type: CalculationType = 'profit_calc'
    
    # 尺寸信息
    package_length_cm: float
    package_width_cm: float
    package_height_cm: float
    weight_kg: float
    
    # 成本信息
    fob_product_cost_rmb: float
    first_leg_cost_rmb: float
    ddp_cost_rmb: float
    ddp_cost_usd: float
    
    # 销售参数
    sale_price_usd: float
    target_profit_rate: float | None = None
    advertising_rate: float
    return_loss_rate: float
    storage_months: float
    inbound_placement_mode: InboundPlacementMode
    
    # 汇率
    usd_to_rmb_rate: float
    usd_to_rmb_rate_source: str
    
    # 尺寸等级和售价带
    size_tier: str
    size_tier_label: str
    price_band: str
    price_band_label: str
    
    # 尺寸详情
    longest_side_in: float
    middle_side_in: float
    shortest_side_in: float
    length_plus_girth_in: float
    volume_cubic_in: float
    volume_cubic_ft: float
    
    # 重量详情
    product_weight_lb: float
    product_weight_oz: float
    dimensional_weight_lb: float
    chargeable_weight_lb: float
    chargeable_weight_oz: float
    chargeable_weight_rule: str
    
    # 费用规则标签
    fulfillment_fee_rule_label: str
    inbound_config_fee_rule_label: str
    storage_fee_rule_label: str
    
    # 费用详情
    referral_fee_usd: float
    advertising_fee_usd: float
    return_loss_usd: float
    fba_fulfillment_fee_usd: float
    inbound_config_fee_usd: float
    storage_fee_usd: float
    total_fee_usd: float
    
    # 利润详情
    payout_usd: float
    profit_usd: float
    profit_rate: float
    
    # 警告信息
    warnings: list[str] = Field(default_factory=list)
    # 备注
    notes: str | None = None


class StoreSkuPricingSnapshotListResponse(BaseModel):
    """店铺 SKU 核算快照列表响应"""
    items: list[StoreSkuPricingSnapshotItem]
    total: int
    page: int
    page_size: int

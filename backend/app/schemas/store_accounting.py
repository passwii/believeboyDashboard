from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


InboundPlacementMode = Literal['single_destination', 'amazon_optimized_split']
AccountingType = Literal['profit_calc', 'eu_accounting']
Country = Literal['US', 'DE', 'UK']


class StoreAccountingDimensions(BaseModel):
    longest_side_in: float
    middle_side_in: float
    shortest_side_in: float
    length_plus_girth_in: float
    volume_cubic_in: float
    volume_cubic_ft: float


class StoreAccountingWeight(BaseModel):
    product_weight_lb: float
    product_weight_oz: float
    dimensional_weight_lb: float
    chargeable_weight_lb: float
    chargeable_weight_oz: float
    chargeable_weight_rule: str


class StoreAccountingFees(BaseModel):
    referral_fee_usd: float
    advertising_fee_usd: float
    return_loss_usd: float
    fba_fulfillment_fee_usd: float
    inbound_config_fee_usd: float
    storage_fee_usd: float
    total_fee_usd: float
    # EU 手动填写费用
    delivery_fee_usd: float = 0.0
    inbound_config_fee_manual_usd: float = 0.0
    storage_fee_manual_usd: float = 0.0
    # EU 平台佣金（售价 * 15%）
    platform_fee_usd: float = 0.0


class StoreAccountingProfit(BaseModel):
    ddp_cost_rmb: float
    ddp_cost_usd: float
    payout_usd: float
    profit_usd: float
    profit_rate: float
    # EU VAT
    vat_usd: float = 0.0
    profit_after_vat_usd: float | None = None
    profit_after_vat_rate: float | None = None


class StoreAccountingItem(BaseModel):
    """店铺核算详情"""
    id: int
    project_id: int
    project_name: str
    sku: str
    asin: str | None = None
    country: Country
    accounting_type: AccountingType = 'profit_calc'

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

    # 费用规则标签
    fulfillment_fee_rule_label: str
    inbound_config_fee_rule_label: str
    storage_fee_rule_label: str

    # 尺寸详情
    dimensions: StoreAccountingDimensions
    # 重量详情
    weights: StoreAccountingWeight
    # 费用详情
    fees: StoreAccountingFees
    # 利润详情
    profit: StoreAccountingProfit

    # 警告信息
    warnings: list[str] = Field(default_factory=list)
    # 备注
    notes: str | None = None
    # 操作人
    created_by: str | None = None
    created_at: datetime
    updated_at: datetime


class StoreAccountingCreateRequest(BaseModel):
    """创建/更新店铺核算的请求"""
    project_id: int
    project_name: str
    sku: str
    asin: str | None = None
    country: Country
    accounting_type: AccountingType = 'profit_calc'

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
    # EU 手动填写费用
    delivery_fee_usd: float = 0.0
    inbound_config_fee_manual_usd: float = 0.0
    storage_fee_manual_usd: float = 0.0
    # EU 平台佣金（售价 * 15%）
    platform_fee_usd: float = 0.0

    # 利润详情
    payout_usd: float
    profit_usd: float
    profit_rate: float
    # EU VAT
    vat_usd: float = 0.0
    profit_after_vat_usd: float | None = None
    profit_after_vat_rate: float | None = None

    # 警告信息
    warnings: list[str] = Field(default_factory=list)
    # 备注
    notes: str | None = None


class StoreAccountingListResponse(BaseModel):
    """店铺核算列表响应"""
    items: list[StoreAccountingItem]
    total: int
    page: int
    page_size: int

"""Agent 店铺测算域请求 schema（BLF-442，spec §3）。

``AgentShopCalculationAppendRequest`` 镜像内部 ``ShopCalculationCreateRequest``
全字段，去掉 2 个服务端派生项（``project_id`` / ``project_name``，路由层从路径
Project 派生）；``source`` 收紧为必填 agent 采集渠道枚举（禁 manual），
``observed_at`` 可选（Agent 补录历史价）。

``AgentShopCalculationComputeRequest`` 是 /compute 试算请求：profit_calc 镜像
PricingCalculationCreateRequest（country=US），eu_accounting 镜像
PricingCalculationEURequest（country=DE|UK，含三笔手动费）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.shop_calculation import AccountingType, Country, InboundPlacementMode

# Agent 写入允许的采集渠道（spec §3.1：禁 manual，审计溯源要求声明渠道）。
AgentCalculationSource = Literal[
    "agent_listing_pull",
    "agent_review_scrape",
    "agent_market_research",
    "external_api",
]

ComputeMode = Literal["profit_calc", "eu_accounting"]


class AgentShopCalculationAppendRequest(BaseModel):
    """追加写请求（W1）：快照全字段，project_id/project_name 服务端派生。"""

    sku: str
    asin: str | None = None
    country: Country
    accounting_type: AccountingType = "profit_calc"

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

    # 警告信息 / 备注
    warnings: list[str] = Field(default_factory=list)
    notes: str | None = None

    # 采集渠道（必填，无默认；禁 manual —— 审计溯源要求声明渠道）
    source: AgentCalculationSource
    # 补录历史价时用；缺省后端取 now()
    observed_at: datetime | None = None

    @model_validator(mode="after")
    def _mark_negative_profit(self) -> AgentShopCalculationAppendRequest:
        """负利润是合法经营结果，但必须显式留痕，便于 Agent/审计追踪。"""
        if (
            self.profit_usd < 0 or self.profit_rate < 0
        ) and "NEGATIVE_PROFIT" not in self.warnings:
            self.warnings.append("NEGATIVE_PROFIT")
        return self


class AgentShopCalculationComputeRequest(BaseModel):
    """试算请求（C1）：双模式，纯计算不落库。"""

    mode: ComputeMode
    country: str = Field(default="US", max_length=10)
    product_name: str = Field(min_length=1, max_length=255)
    sku: str | None = Field(default=None, min_length=1, max_length=100)

    # 尺寸 / 成本 / 售价（引擎必填）
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)
    fob_product_cost_rmb: float = Field(ge=0, le=100000000)
    first_leg_cost_rmb: float = Field(ge=0, le=100000000)
    sale_price_usd: float = Field(gt=0, le=100000000)

    # 销售参数（与内部 quote 默认值对齐）
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    storage_months: float = Field(default=1, gt=0, le=120)
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)

    # 目标净利率（BLF-1043，可选）：响应 anchor 里额外返回
    # target_advertising_rate = 盈亏平衡广告费率 − target_net_margin。
    # 允许负值（「清库存」档允许亏），故 ge=-1 而不是 ge=0。
    target_net_margin: float | None = Field(default=None, ge=-1, le=1)

    # EU 专属（mode=eu_accounting 时手动填写费，默认 0）
    delivery_fee_usd: float = Field(default=0.0, ge=0, le=100000)
    inbound_config_fee_usd: float = Field(default=0.0, ge=0, le=100000)
    storage_fee_usd: float = Field(default=0.0, ge=0, le=100000)

    @model_validator(mode="after")
    def _check_country_mode(self) -> AgentShopCalculationComputeRequest:
        if self.mode == "eu_accounting" and self.country not in ("DE", "UK"):
            raise ValueError("eu_accounting 模式 country 必须是 DE 或 UK")
        if self.mode == "profit_calc" and self.country != "US":
            raise ValueError("profit_calc 模式 country 必须是 US")
        return self

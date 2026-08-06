"""Agent 新品测算域请求 schema（BLF-451，spec §5）。

``AgentNewProductCalculationUpsertRequest`` 镜像内部
``NewProductCalculationCreateRequest`` 全字段，去掉 3 个服务端派生项
（``project_id`` / ``project_name`` / ``created_by``，路由层派生）；
``source`` 收紧为必填 agent 采集渠道枚举（禁 manual），``observed_at`` 可选
（缺省后端取 now()）。

``AgentNewProductCalculationComputeRequest`` 是 C1 /compute 试算请求：
``mode`` 4 种（D2 拍板：profit_calc / profit_reverse / cost_reverse /
fbm_calc，EU 不纳入新品域），各模式必要元素差异由 ``@model_validator`` 卡死
（镜像 spec §2 模式矩阵）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.new_product_calculation import (
    AgentCalculationType,
    InboundPlacementMode,
)

# Agent 写入允许的采集渠道（spec §6.2：必填，禁 manual —— 审计溯源要求声明渠道）。
AgentCalculationSource = Literal[
    "agent_listing_pull",
    "agent_review_scrape",
    "agent_market_research",
    "external_api",
]

# /compute 试算模式（D2 拍板 4 种；EU 不纳入新品域）。
ComputeMode = Literal["profit_calc", "profit_reverse", "cost_reverse", "fbm_calc"]


class AgentNewProductCalculationUpsertRequest(BaseModel):
    """W1 快照写请求：快照全字段，project_id/project_name/created_by 服务端派生。"""

    sku: str
    asin: str | None = None
    country: str | None = None
    calculation_type: AgentCalculationType = "profit_calc"

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
    # EU 手动填写费用（新品域 4 模式无 EU，保留默认值兼容）
    delivery_fee_usd: float = 0.0
    inbound_config_fee_manual_usd: float = 0.0
    storage_fee_manual_usd: float = 0.0

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

    # 溯源字段（D1 拍板：必填，无默认；禁 manual —— 审计溯源要求声明渠道）
    source: AgentCalculationSource
    # 观测时刻；缺省后端取 now()
    observed_at: datetime | None = None


class AgentNewProductCalculationComputeRequest(BaseModel):
    """C1 试算请求（spec §5.3）：mode 4 种，纯计算不落库。"""

    mode: ComputeMode
    country: str = Field(default="US", max_length=10)
    product_name: str = Field(min_length=1, max_length=255)
    sku: str | None = Field(default=None, min_length=1, max_length=100)
    asin: str | None = None

    # 物理规格层（所有模式必填）
    package_length_cm: float = Field(gt=0, le=1000)
    package_width_cm: float = Field(gt=0, le=1000)
    package_height_cm: float = Field(gt=0, le=1000)
    weight_kg: float = Field(gt=0, le=1000)

    # 成本层（cost_reverse 不得传 fob_product_cost_rmb；FBM 可用整柜分摊头程）
    fob_product_cost_rmb: float | None = Field(default=None, ge=0, le=100000000)
    first_leg_cost_rmb: float | None = Field(default=None, ge=0, le=100000000)
    first_leg_unit_price_rmb: float | None = Field(default=None, ge=0, le=10000)
    use_historical_shipping_cost: bool = False

    # 销售参数层（profit_reverse 不得传 sale_price_usd；reverse/cost_reverse 必填 target_profit_rate）
    sale_price_usd: float | None = Field(default=None, gt=0, le=100000000)
    target_profit_rate: float | None = Field(default=None, ge=0, lt=1)

    # 费率默认组（可选，缺省用引擎默认）
    commission_rate: float = Field(default=0.15, ge=0, le=1)
    advertising_rate: float = Field(default=0.12, ge=0, le=1)
    return_loss_rate: float = Field(default=0.04, ge=0, le=1)
    storage_months: float = Field(default=1, gt=0, le=120)
    inbound_placement_mode: InboundPlacementMode = "single_destination"
    usd_to_rmb_rate: float | None = Field(default=None, gt=0, le=1000)

    # 模式专属（fbm_calc 整柜 + 派送费）
    full_container_quantity: float | None = Field(default=None, gt=0, le=100000)
    full_container_price_rmb: float | None = Field(default=None, ge=0, le=100000000)
    delivery_fee_usd: float = Field(default=0.0, ge=0, le=100000)

    @model_validator(mode="after")
    def _check_mode_fields(self) -> "AgentNewProductCalculationComputeRequest":
        if self.mode in ("profit_calc", "fbm_calc"):
            if self.fob_product_cost_rmb is None:
                raise ValueError(f"{self.mode} 模式必填 fob_product_cost_rmb")
            if self.sale_price_usd is None:
                raise ValueError(f"{self.mode} 模式必填 sale_price_usd")
        if self.mode == "profit_reverse":
            if self.sale_price_usd is not None:
                raise ValueError(
                    "profit_reverse 模式不得传 sale_price_usd（售价是输出）"
                )
            if self.target_profit_rate is None:
                raise ValueError("profit_reverse 模式必填 target_profit_rate")
            if self.fob_product_cost_rmb is None:
                raise ValueError("profit_reverse 模式必填 fob_product_cost_rmb")
        if self.mode == "cost_reverse":
            if self.fob_product_cost_rmb is not None:
                raise ValueError(
                    "cost_reverse 模式不得传 fob_product_cost_rmb（FOB 成本是输出）"
                )
            if self.sale_price_usd is None:
                raise ValueError("cost_reverse 模式必填 sale_price_usd")
            if self.target_profit_rate is None:
                raise ValueError("cost_reverse 模式必填 target_profit_rate")
        if self.mode == "fbm_calc":
            if self.full_container_quantity is None:
                raise ValueError("fbm_calc 模式必填 full_container_quantity")
            if self.full_container_price_rmb is None:
                raise ValueError("fbm_calc 模式必填 full_container_price_rmb")
        if self.mode != "fbm_calc":
            # 非 FBM 模式整柜字段不参与计算（引擎 getattr 缺省 0）
            self.full_container_quantity = None
            self.full_container_price_rmb = None
        return self

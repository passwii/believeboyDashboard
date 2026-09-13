"""定价派生块：盈亏平衡广告费率 / 目标广告费率（BLF-1043）。

三层 API 的店铺测算、定价快照、新品测算三个域都用这一个形状（``PricingAnchor``）：

* **富契约**（`ShopCalculationItem` / `NewProductCalculationItem`）挂嵌套
  ``anchor`` 块（可关：``?include_anchor=false``）；
* **BI 扁平契约**（`ShopCalculationHistoryRow`）**不挂嵌套块**，改为显式补一个
  ``breakeven_advertising_rate`` 列（扁平行没有费用拆项，消费方自己算不出来）。

口径与边界（详见 ``app/services/pricing/anchor.py`` 模块 docstring）：

* ``breakeven_advertising_rate`` — 盈亏平衡广告费率（= 运营口径的「盈亏平衡 ACOS」；
  定价域内无「广告销售额」概念，故不叫 ``acos``，沿用 ``advertising_rate`` 命名族）。
  比率精度 4 位小数。``sale_price_usd == 0`` → ``None``；**不 clamp 到 [0, 1]**，
  负数（成本已高于售价）原样返回 —— 负值本身就是诊断信号。
* ``non_ad_fee_usd`` — 锚的分母拆项（``total_fee_usd - advertising_fee_usd``），
  解释「为什么这个 SKU 锚只有 12.6%」时必须看它。
* ``max_ad_spend_per_unit_usd`` — ``sale_price_usd × breakeven_advertising_rate``，
  打平前每单可用广告费上限（= ``profit_usd + advertising_fee_usd``，看钱比看比率直观）。
* ``breakeven_advertising_rate_after_vat`` — 与既有 ``profit_after_vat_*`` 同族；
  含 VAT 站点返回实数，**美国返回 ``None``**（避免被误读为「美国有 VAT」）。
* ``target_net_margin`` / ``target_advertising_rate`` — 仅当调用方传
  ``target_net_margin`` 时返回，否则 ``None``。``target_advertising_rate =
  breakeven_advertising_rate - target_net_margin``（目标净利率为 0 时即盈亏平衡）。
  「清库存」档允许亏（目标净利率 −10pt），故入参校验是 ``ge=-1, le=1`` 而非 ``ge=0``。
* ``basis`` — 锚依赖的汇率与观测时刻（``observed_at`` / ``usd_to_rmb_rate`` /
  ``usd_to_rmb_rate_source``）。汇率换了锚就漂（实测同 SKU fx 6.7894 → 29.80%、
  fx 6.7078 → 29.38%），所以消费方必须能把 ``anchor`` 当**自包含对象**缓存与版本化。

以上字段全部是**读取时派生**（纯代数，闭式解），不落库、不改 append-only 语义。
``return_loss_usd`` 是期望值（``sale_price_usd × return_loss_rate``），因此锚是
「按当前退货率假设的期望锚」，不是「零退货锚」。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class AnchorBasis(BaseModel):
    """锚所依据的汇率 / 观测时刻（自包含缓存所需）。"""

    observed_at: datetime | None = Field(
        default=None,
        description="本行快照的观测时刻（compute 试算无落库行，返回 null）",
    )
    usd_to_rmb_rate: float | None = Field(
        default=None, description="锚所依据的 USD→RMB 汇率"
    )
    usd_to_rmb_rate_source: str | None = Field(
        default=None, description="汇率来源（manual / system:YYYY-MM 等）"
    )


class PricingAnchor(BaseModel):
    """派生块：盈亏平衡广告费率 +（可选）目标广告费率。"""

    breakeven_advertising_rate: float | None = Field(
        default=None,
        description=(
            "盈亏平衡广告费率（比率，非百分数）。sale_price_usd=0 时为 null；"
            "成本高于售价时可能 < 0（不 clamp）"
        ),
    )
    non_ad_fee_usd: float | None = Field(
        default=None, description="非广告费用（total_fee_usd − advertising_fee_usd）"
    )
    max_ad_spend_per_unit_usd: float | None = Field(
        default=None,
        description="打平前每单可用广告费上限（sale_price_usd × breakeven_advertising_rate）",
    )
    breakeven_advertising_rate_after_vat: float | None = Field(
        default=None,
        description="含 VAT 口径的盈亏平衡广告费率；无 VAT 站点（US）为 null",
    )
    target_net_margin: float | None = Field(
        default=None, description="调用方传入的目标净利率（回显）；未传为 null"
    )
    target_advertising_rate: float | None = Field(
        default=None,
        description=(
            "目标广告费率 = breakeven_advertising_rate − target_net_margin；"
            "未传 target_net_margin 为 null"
        ),
    )
    basis: AnchorBasis = Field(default_factory=AnchorBasis)


__all__ = ["AnchorBasis", "PricingAnchor"]

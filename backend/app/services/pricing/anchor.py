"""盈亏平衡广告费率 / 目标广告费率（BLF-1043）。

``advertising_rate`` 在定价引擎里只以线性项 ``sale_price_usd × advertising_rate``
出现（其余费用与它无关），所以「利润归零的广告费率」是一元一次方程，有闭式解：

    non_ad_fee_usd = total_fee_usd - advertising_fee_usd
    breakeven_advertising_rate = 1 - (non_ad_fee_usd + ddp_cost_usd + vat_usd) / sale_price_usd

恒等式（免费自检口径）：``breakeven_advertising_rate ≡ advertising_rate + profit_rate``

    推导：profit_rate = [price − non_ad_fee − price·rate − ddp] / price = breakeven − rate

两侧都是引擎口径（``advertising_fee_usd`` / ``profit_usd`` 各自 2 位金额舍入、
``profit_rate`` 4 位比率舍入），故残差上界 ≈ ``0.01 / sale_price_usd``：低价 SKU
（$8.39）上是 1e-3 量级、$40+ 上是 1e-4 量级。断言恒等式时容差要按价格推导，
不要硬写 1e-4 —— 那是舍入地板，不是公式误差。

**为什么用闭式解而不是二分**：广告费率不进入任何费率阶梯（``reverse.py`` /
``cost_reverse.py`` 两条反算求解器用二分是因为它们解的量会跨费率阶梯，非单调）。

字段口径与边界：

* 比率一律 4 位小数（``_ratio_decimal``），**不能用金额精度**——低价 SKU 上 2 位
  舍入 = 1pt 误差（CF13SET 锚 12.6%，错 1pt 就是 8% 相对误差）。
* ``non_ad_fee_usd`` 由 ``total_fee_usd - advertising_fee_usd`` 减出来，**不**再加
  EU 的 ``platform_fee_usd``：它在 EU 结果里恒等于 ``referral_fee_usd``（同一笔佣金
  的别名，``computation.py``），加一次就重复计佣。EU 三笔手动费
  （``delivery_fee_usd`` / ``inbound_config_fee_manual_usd`` /
  ``storage_fee_manual_usd``）已由引擎以 ``fba_fulfillment_fee_usd`` /
  ``inbound_config_fee_usd`` / ``storage_fee_usd`` 为别名回填进 ``total_fee_usd``，
  所以减出来的就是真正的「非广告费用」。
* 退货损失 ``return_loss_usd`` 是**期望值**（``price × return_loss_rate``），故锚是
  「按当前退货率假设的期望锚」。
* 边界：``sale_price_usd == 0`` → ``None``（返回 0 会被读成「广告一分不能花」）；
  闭式解 ≤ 0 或 ≥ 1 **原样返回，不 clamp**（负值 = 成本已高于售价，是诊断信号）。

签名说明：求解器取的是 **纯代数** 形式 ``(breakeven_advertising_rate,
target_net_margin)``，不是 ``(payload, db)``——每个调用点都已经拿着引擎算好的费用
拆项（``fees_decimal`` / 行上的列），再收 ``payload, db`` 只会让调用方重跑一遍引擎
（汇率 / 头程解析都要查库）去买一个减法。需要「从原始 payload 起算」的调用方请先走
``_compute_pricing`` / ``_compute_eu_pricing`` 再用 ``_anchor_from_computed``。
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any

from app.schemas.pricing_anchor import AnchorBasis, PricingAnchor
from app.services.pricing.utils import _decimal, _money_decimal, _ratio_decimal

__all__ = [
    "_anchor_from_amounts",
    "_anchor_from_computed",
    "_anchor_from_item",
    "_breakeven_advertising_rate",
    "_solve_advertising_rate_for_profit_rate",
]


def _breakeven_advertising_rate(
    non_ad_fee_usd: Decimal,
    ddp_cost_usd: Decimal,
    sale_price_usd: Decimal,
    vat_usd: Decimal = Decimal(0),
) -> Decimal | None:
    """闭式解：利润归零的广告费率。``sale_price_usd <= 0`` → ``None``。

    不 clamp：结果可能是负数（不花广告费也亏）或 ≥ 1（只在负成本下出现），
    两者都原样返回。
    """
    if sale_price_usd is None or sale_price_usd <= 0:
        return None
    return _ratio_decimal(
        Decimal(1) - (non_ad_fee_usd + ddp_cost_usd + vat_usd) / sale_price_usd
    )


def _solve_advertising_rate_for_profit_rate(
    breakeven_advertising_rate: Decimal | None,
    target_net_margin: float | Decimal | None,
) -> Decimal | None:
    """给目标净利率 → 目标广告费率：``breakeven − target_net_margin``。

    ``target_net_margin`` 为 0 时即盈亏平衡本身；允许为负（清库存档允许亏）。
    任一入参缺失 → ``None``（缺省不传 target 时字段返回 null，不猜业务默认值）。
    """
    if breakeven_advertising_rate is None or target_net_margin is None:
        return None
    return _ratio_decimal(breakeven_advertising_rate - _decimal(target_net_margin))


def _anchor_from_amounts(
    *,
    total_fee_usd: Decimal | float,
    advertising_fee_usd: Decimal | float,
    ddp_cost_usd: Decimal | float,
    sale_price_usd: Decimal | float,
    vat_usd: Decimal | float | None = None,
    usd_to_rmb_rate: Decimal | float | None = None,
    usd_to_rmb_rate_source: str | None = None,
    observed_at: datetime | None = None,
    target_net_margin: float | Decimal | None = None,
) -> PricingAnchor:
    """从「已算好的费用拆项」构造 ``anchor`` 块（唯一落计算公式的地方）。

    ``vat_usd=None`` 表示**该站点无 VAT**（如 US）→``…_after_vat`` 返回 ``None``，
    而不是 0（0 会被误读成「美国 VAT 是 0」）。
    """
    total_fee = _money_decimal(_decimal(total_fee_usd))
    advertising_fee = _money_decimal(_decimal(advertising_fee_usd))
    ddp_cost = _money_decimal(_decimal(ddp_cost_usd))
    sale_price = _money_decimal(_decimal(sale_price_usd))
    vat = None if vat_usd is None else _money_decimal(_decimal(vat_usd))

    non_ad_fee = _money_decimal(total_fee - advertising_fee)
    breakeven = _breakeven_advertising_rate(non_ad_fee, ddp_cost, sale_price)
    breakeven_after_vat = (
        _breakeven_advertising_rate(non_ad_fee, ddp_cost, sale_price, vat)
        if vat is not None
        else None
    )
    target_advertising_rate = _solve_advertising_rate_for_profit_rate(
        breakeven, target_net_margin
    )
    max_ad_spend = (
        _money_decimal(sale_price * breakeven) if breakeven is not None else None
    )
    target_margin = (
        _ratio_decimal(_decimal(target_net_margin))
        if target_net_margin is not None
        else None
    )
    rate = _decimal(usd_to_rmb_rate) if usd_to_rmb_rate is not None else None

    return PricingAnchor(
        breakeven_advertising_rate=_float_or_none(breakeven),
        non_ad_fee_usd=_float_or_none(non_ad_fee),
        max_ad_spend_per_unit_usd=_float_or_none(max_ad_spend),
        breakeven_advertising_rate_after_vat=_float_or_none(breakeven_after_vat),
        target_net_margin=_float_or_none(target_margin),
        target_advertising_rate=_float_or_none(target_advertising_rate),
        basis=AnchorBasis(
            observed_at=observed_at,
            usd_to_rmb_rate=_float_or_none(rate),
            usd_to_rmb_rate_source=usd_to_rmb_rate_source,
        ),
    )


def _anchor_from_computed(
    computed: dict[str, Any],
    *,
    target_net_margin: float | Decimal | None = None,
    observed_at: datetime | None = None,
) -> PricingAnchor:
    """引擎试算结果（``_compute_pricing`` / ``_compute_eu_pricing`` / FBM）→ ``anchor``。

    覆盖 profit_calc / eu_accounting / fbm_calc 三套引擎：它们的
    ``fees_decimal`` / ``profit_decimal`` / ``inputs`` 键集是同一套，VAT 是否适用由
    ``profit_after_vat_rate`` 是否为 ``None`` 判定（US 无 VAT → 该字段为 None）。
    """
    fees = computed["fees_decimal"]
    profit = computed["profit_decimal"]
    inputs = computed["inputs"]
    vat_applicable = profit.get("profit_after_vat_rate") is not None
    return _anchor_from_amounts(
        total_fee_usd=fees["total_fee_usd"],
        advertising_fee_usd=fees["advertising_fee_usd"],
        ddp_cost_usd=profit["ddp_cost_usd"],
        sale_price_usd=inputs["sale_price_usd"],
        vat_usd=profit.get("vat_usd") if vat_applicable else None,
        usd_to_rmb_rate=computed.get("usd_to_rmb_rate"),
        usd_to_rmb_rate_source=computed.get("usd_to_rmb_rate_source"),
        observed_at=observed_at,
        target_net_margin=target_net_margin,
    )


def _anchor_from_item(
    item: Any,
    *,
    target_net_margin: float | Decimal | None = None,
) -> PricingAnchor:
    """富契约 item（``ShopCalculationItem`` / ``NewProductCalculationItem``）→ ``anchor``。

    行上已有全部费用拆项（``fees`` / ``profit`` 嵌套块），所以**读取时派生**即可，
    不落库、无迁移、不影响 append-only 语义。
    """
    fees = item.fees
    profit = item.profit
    vat_applicable = getattr(profit, "profit_after_vat_rate", None) is not None
    return _anchor_from_amounts(
        total_fee_usd=fees.total_fee_usd,
        advertising_fee_usd=fees.advertising_fee_usd,
        ddp_cost_usd=profit.ddp_cost_usd,
        sale_price_usd=item.sale_price_usd,
        vat_usd=getattr(profit, "vat_usd", 0) if vat_applicable else None,
        usd_to_rmb_rate=item.usd_to_rmb_rate,
        usd_to_rmb_rate_source=item.usd_to_rmb_rate_source,
        observed_at=getattr(item, "observed_at", None),
        target_net_margin=target_net_margin,
    )


def _float_or_none(value: Decimal | None) -> float | None:
    """Decimal → JSON 友好的 float（``None`` 透传）。

    全部 Decimal→float 窄化只走这一处。用 ``Decimal.__float__()`` 而不是
    ``float(value)``：语义完全相同（入参已是 Decimal，不可能抛 ValueError），
    但仓库级 ast-grep 规则 ``unchecked-throwing-call-python``（它针对的是
    ``float(str)``）会把 ``float(<变量>)`` 一律判成「未处理异常」，而 pyright 又
    必须看到显式窄化（pydantic 的 ``float`` 字段不接受 ``Decimal``）。
    """
    if value is None:
        return None
    return value.__float__()

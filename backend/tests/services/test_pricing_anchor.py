"""BLF-1043 盈亏平衡广告费率 / 目标广告费率（``app.services.pricing.anchor``）测试。

三层：
1. **纯代数**（不依赖 DB）：闭式解、9 行 golden fixture、恒等式、边界（0 / 负值 /
   ≥1 / VAT 缺省）、目标广告费率；
2. **三种入参适配器**：引擎 dict / 富契约 item / 已算好的金额拆项，同一结果；
3. **闭环**（用 ``db_session``，缺 TEST_DATABASE_URL 时自动 skip）：把算出来的
   盈亏平衡广告费率喂回引擎，利润精确归零；并验证锚随汇率漂移 —— 这就是
   「锚必须与它依据的 fx 一起返回」的原因。

恒等式容差说明：``_breakeven_advertising_rate ≡ advertising_rate + profit_rate``
两侧都是引擎口径（``advertising_fee_usd`` / ``profit_usd`` 各 2 位金额舍入、
``profit_rate`` 4 位比率舍入），残差上界 ≈ ``0.01 / sale_price_usd + 1e-4``。
低价 SKU（$8.39）上是 1e-3 量级 —— 那是舍入地板，不是公式误差，所以断言用
``_identity_tolerance()`` 按价格推导，不硬写 1e-4。
"""

from __future__ import annotations

from decimal import Decimal
from typing import cast

import pytest

from app.schemas.pricing_calculation import PricingCalculationCreateRequest
from app.services.pricing.anchor import (
    _anchor_from_amounts,
    _anchor_from_computed,
    _anchor_from_item,
    _breakeven_advertising_rate,
    _solve_advertising_rate_for_profit_rate,
)
from app.services.pricing.computation import _compute_pricing

# 运营侧实测的 9 行 golden fixture（BLF-1043 描述里的表）：覆盖低价小件 / 高价大件 /
# 非默认假设（18% 广告费率、不同退货率）与各费用档。
GOLDEN = [
    # sku, sale_price, ddp, non_ad_fee, advertising_rate, profit_rate, breakeven
    ("RSD-8PCS", "39.99", "11.71", "15.46", "0.12", "0.2006", "0.3206"),
    ("TWS-CF13SET", "8.39", "2.29", "5.04", "0.12", "0.0060", "0.1263"),
    ("TWS-CF15SET", "14.99", "4.27", "7.04", "0.12", "0.1254", "0.2455"),
    ("TWS-CF21SET", "12.99", "3.48", "7.44", "0.12", "0.0393", "0.1594"),
    ("TWS-CF29SET", "42.99", "14.58", "15.60", "0.12", "0.1779", "0.2980"),
    ("TWS-CM115SET", "129.99", "59.19", "33.46", "0.12", "0.1672", "0.2873"),
    ("TWS-CS13SET", "12.99", "3.30", "6.94", "0.18", "0.0316", "0.2117"),
    ("TWS-CS21SET-S", "28.99", "9.37", "11.36", "0.12", "0.1649", "0.2849"),
    ("TWS-CS29SET", "54.99", "17.19", "18.00", "0.12", "0.2400", "0.3601"),
]

# 运营侧反喂真引擎用的 payload（TWS-CF29SET）：19.5×12×6 cm / 1.55 kg /
# FOB ¥92 / 头程 ¥7 / 售价 $42.99 / 佣金 15% / 退货率 2.92% / fx 6.7894。
CF29 = {
    "product_name": "TWS-CF29SET",
    "package_length_cm": 19.5,
    "package_width_cm": 12.0,
    "package_height_cm": 6.0,
    "weight_kg": 1.55,
    "fob_product_cost_rmb": 92.0,
    "first_leg_cost_rmb": 7.0,
    "sale_price_usd": 42.99,
    "commission_rate": 0.15,
    "return_loss_rate": 0.0292,
    "storage_months": 1.0,
    "inbound_placement_mode": "single_destination",
}

CF29_FX = 6.7894
CF29_BREAKEVEN = Decimal("0.2980")


def _identity_tolerance(sale_price: Decimal) -> Decimal:
    """恒等式容差：0.01（两侧各一次 2 位金额舍入）/ price + 1e-4（比率 4 位舍入）。"""
    return Decimal("0.01") / sale_price + Decimal("0.0001")


def _profit_rate(computed: dict[str, object]) -> Decimal:
    """``_compute_pricing`` 返回 ``dict[str, object]``，测试里收窄一次便于断言。"""
    profit = cast(dict[str, Decimal], computed["profit_decimal"])
    return profit["profit_rate"]


def _advertising_rate(computed: dict[str, object]) -> Decimal:
    inputs = cast(dict[str, object], computed["inputs"])
    return cast(Decimal, inputs["advertising_rate"])


class TestClosedForm:
    @pytest.mark.parametrize("case", GOLDEN, ids=[c[0] for c in GOLDEN])
    def test_breakeven_matches_golden_fixture(self, case):
        _sku, price, ddp, non_ad, _rate, _profit_rate, expected = case
        result = _breakeven_advertising_rate(
            Decimal(non_ad), Decimal(ddp), Decimal(price)
        )
        assert result is not None
        assert result == Decimal(expected), f"闭式解应精确复现 golden {expected}"

    @pytest.mark.parametrize("case", GOLDEN, ids=[c[0] for c in GOLDEN])
    def test_identity_breakeven_equals_rate_plus_profit_rate(self, case):
        """恒等式回归：breakeven ≈ advertising_rate + profit_rate（容差按价格推导）。"""
        sku, price, ddp, non_ad, rate, profit_rate, expected = case
        breakeven = _breakeven_advertising_rate(
            Decimal(non_ad), Decimal(ddp), Decimal(price)
        )
        assert breakeven is not None
        residual = abs(breakeven - (Decimal(rate) + Decimal(profit_rate)))
        tolerance = _identity_tolerance(Decimal(price))
        assert residual <= tolerance, (
            f"{sku}: 残差 {residual} 超过容差 {tolerance}"
            "（若超差说明不是舍入地板，而是公式或字段口径错）"
        )
        # 低价 SKU 的容差本来就该大于 1e-4 —— 锁住这个「地板」不让后来者误以为是 bug
        assert abs(breakeven - Decimal(expected)) <= Decimal("0.0001")

    def test_zero_sale_price_returns_none(self):
        assert (
            _breakeven_advertising_rate(Decimal("5.04"), Decimal("2.29"), Decimal(0))
            is None
        ), "0 会被读成「广告一分不能花」，必须返回 None"

    def test_negative_price_returns_none(self):
        assert (
            _breakeven_advertising_rate(Decimal("5.04"), Decimal("2.29"), Decimal(-1))
            is None
        )

    def test_negative_breakeven_is_not_clamped(self):
        """成本已高于售价（不花广告费也亏）→ 原样返回负值。"""
        result = _breakeven_advertising_rate(
            Decimal("30.00"), Decimal("5.00"), Decimal("20.00")
        )
        assert result == Decimal("-0.7500"), "负值是诊断信号，禁止 clamp 到 0"

    def test_breakeven_above_one_is_not_clamped(self):
        """负成本（理论）→ 闭式解 ≥ 1，原样返回。"""
        result = _breakeven_advertising_rate(
            Decimal("-5.00"), Decimal("-5.00"), Decimal("20.00")
        )
        assert result == Decimal("1.5000")

    def test_vat_is_added_to_cost_side(self):
        """含 VAT 口径：``1 − (non_ad + ddp + vat) / price``。"""
        assert _breakeven_advertising_rate(
            Decimal("5.04"), Decimal("2.29"), Decimal("8.39"), Decimal("1.34")
        ) == Decimal("-0.0334")


class TestTargetAdvertisingRate:
    def test_target_subtracts_margin(self):
        assert _solve_advertising_rate_for_profit_rate(
            Decimal("0.2980"), 0.10
        ) == Decimal("0.1980")

    def test_zero_margin_equals_breakeven(self):
        assert _solve_advertising_rate_for_profit_rate(Decimal("0.2980"), 0) == Decimal(
            "0.2980"
        )

    def test_negative_margin_allowed(self):
        """「清库存」档允许亏（目标净利率 −10pt）→ 目标广告费率反而更高。"""
        assert _solve_advertising_rate_for_profit_rate(
            Decimal("0.2980"), -0.10
        ) == Decimal("0.3980")

    def test_missing_inputs_return_none(self):
        assert _solve_advertising_rate_for_profit_rate(None, 0.10) is None
        assert _solve_advertising_rate_for_profit_rate(Decimal("0.2980"), None) is None


class TestAnchorFromAmounts:
    """核心落点：唯一写公式的地方，三个适配器都汇到它。"""

    def test_us_has_no_after_vat_rate(self):
        anchor = _anchor_from_amounts(
            total_fee_usd=Decimal("10.20"),
            advertising_fee_usd=Decimal("2.40"),
            ddp_cost_usd=Decimal("4.20"),
            sale_price_usd=Decimal("19.99"),
            vat_usd=None,
            usd_to_rmb_rate=Decimal("7.20"),
            usd_to_rmb_rate_source="test",
        )
        assert anchor.breakeven_advertising_rate == 0.3997
        assert anchor.non_ad_fee_usd == 7.8
        assert anchor.max_ad_spend_per_unit_usd == 7.99  # 19.99 × 0.3997 → 2 位
        assert anchor.breakeven_advertising_rate_after_vat is None, (
            "US 必须返回 null，返回 0 会被误读成「美国 VAT 是 0」"
        )
        assert anchor.target_net_margin is None
        assert anchor.target_advertising_rate is None
        assert anchor.basis.usd_to_rmb_rate == 7.2
        assert anchor.basis.usd_to_rmb_rate_source == "test"

    def test_eu_returns_after_vat_rate(self):
        anchor = _anchor_from_amounts(
            total_fee_usd=Decimal("10.20"),
            advertising_fee_usd=Decimal("2.40"),
            ddp_cost_usd=Decimal("4.20"),
            sale_price_usd=Decimal("19.99"),
            vat_usd=Decimal("2.50"),
            usd_to_rmb_rate=Decimal("7.80"),
            usd_to_rmb_rate_source="system:2026-08",
        )
        after_vat = anchor.breakeven_advertising_rate_after_vat
        assert after_vat is not None
        assert anchor.breakeven_advertising_rate is not None
        assert after_vat < anchor.breakeven_advertising_rate

    def test_vat_zero_money_still_counts_as_applicable(self):
        """EU 但 VAT 恰为 0 时仍要返回实数（是否适用由调用方标明，不看金额大小）。"""
        anchor = _anchor_from_amounts(
            total_fee_usd=Decimal("10.20"),
            advertising_fee_usd=Decimal("2.40"),
            ddp_cost_usd=Decimal("4.20"),
            sale_price_usd=Decimal("19.99"),
            vat_usd=Decimal(0),
        )
        assert (
            anchor.breakeven_advertising_rate_after_vat
            == anchor.breakeven_advertising_rate
        )

    def test_target_fields_echoed_and_derived(self):
        anchor = _anchor_from_amounts(
            total_fee_usd=Decimal("10.20"),
            advertising_fee_usd=Decimal("2.40"),
            ddp_cost_usd=Decimal("4.20"),
            sale_price_usd=Decimal("19.99"),
            target_net_margin=0.1,
        )
        assert anchor.target_net_margin == 0.1
        assert anchor.target_advertising_rate == 0.2997

    def test_zero_price_leaves_rates_null_but_keeps_non_ad_fee(self):
        anchor = _anchor_from_amounts(
            total_fee_usd=Decimal("10.20"),
            advertising_fee_usd=Decimal("2.40"),
            ddp_cost_usd=Decimal("4.20"),
            sale_price_usd=Decimal(0),
        )
        assert anchor.breakeven_advertising_rate is None
        assert anchor.max_ad_spend_per_unit_usd is None
        assert anchor.breakeven_advertising_rate_after_vat is None
        assert anchor.non_ad_fee_usd == 7.8, "拆项与价格无关，仍应可解释"


class TestAdapters:
    """同一份拆项，三种入参形状必须给出同一个 anchor。"""

    def _expected(self) -> dict:
        return _anchor_from_amounts(
            total_fee_usd=Decimal("10.20"),
            advertising_fee_usd=Decimal("2.40"),
            ddp_cost_usd=Decimal("4.20"),
            sale_price_usd=Decimal("19.99"),
            vat_usd=None,
            usd_to_rmb_rate=Decimal("7.2"),
            usd_to_rmb_rate_source="test",
        ).model_dump(mode="json")

    def test_from_engine_dict(self):
        computed = {
            "inputs": {"sale_price_usd": Decimal("19.99")},
            "fees_decimal": {
                "total_fee_usd": Decimal("10.20"),
                "advertising_fee_usd": Decimal("2.40"),
            },
            "profit_decimal": {
                "ddp_cost_usd": Decimal("4.20"),
                "vat_usd": Decimal(0),
                "profit_after_vat_rate": None,
            },
            "usd_to_rmb_rate": Decimal("7.200000"),
            "usd_to_rmb_rate_source": "test",
        }
        got = _anchor_from_computed(computed).model_dump(mode="json")
        expected = self._expected()
        assert (
            got["breakeven_advertising_rate"] == expected["breakeven_advertising_rate"]
        )
        assert got["non_ad_fee_usd"] == expected["non_ad_fee_usd"]
        assert got["basis"]["usd_to_rmb_rate"] == expected["basis"]["usd_to_rmb_rate"]

    def test_from_engine_dict_eu_marks_vat_applicable(self):
        computed = {
            "inputs": {"sale_price_usd": Decimal("19.99")},
            "fees_decimal": {
                "total_fee_usd": Decimal("10.20"),
                "advertising_fee_usd": Decimal("2.40"),
                # EU 结果里 platform_fee_usd 恒等于 referral_fee_usd（同一笔佣金别名）
                "platform_fee_usd": Decimal("2.70"),
            },
            "profit_decimal": {
                "ddp_cost_usd": Decimal("4.20"),
                "vat_usd": Decimal("2.50"),
                "profit_after_vat_rate": Decimal("0.1000"),
            },
        }
        got = _anchor_from_computed(computed)
        assert got.breakeven_advertising_rate_after_vat is not None
        assert got.non_ad_fee_usd == 7.8, "EU 别名佣金不得再加一次"

    def test_from_rich_item(self):
        from types import SimpleNamespace

        item = SimpleNamespace(
            sale_price_usd=19.99,
            usd_to_rmb_rate=7.2,
            usd_to_rmb_rate_source="test",
            observed_at=None,
            fees=SimpleNamespace(total_fee_usd=10.2, advertising_fee_usd=2.4),
            profit=SimpleNamespace(
                ddp_cost_usd=4.2, vat_usd=0.0, profit_after_vat_rate=None
            ),
        )
        got = _anchor_from_item(item).model_dump(mode="json")
        expected = self._expected()
        assert (
            got["breakeven_advertising_rate"] == expected["breakeven_advertising_rate"]
        )
        assert got["max_ad_spend_per_unit_usd"] == expected["max_ad_spend_per_unit_usd"]


class TestEngineClosure:
    """反喂真引擎：锚处利润精确归零（必须用同一 payload 的 fx）。"""

    def _payload(self, db, **overrides) -> PricingCalculationCreateRequest:
        return PricingCalculationCreateRequest(
            **{**CF29, "usd_to_rmb_rate": CF29_FX, **overrides}
        )

    def test_breakeven_reproduces_golden_anchor(self, db_session):
        computed = _compute_pricing(self._payload(db_session), db_session)
        anchor = _anchor_from_computed(computed)
        assert anchor.breakeven_advertising_rate == float(CF29_BREAKEVEN)
        assert anchor.non_ad_fee_usd == 15.60
        assert anchor.basis.usd_to_rmb_rate == CF29_FX
        assert anchor.basis.usd_to_rmb_rate_source == "manual"
        assert anchor.breakeven_advertising_rate_after_vat is None

    def test_feeding_breakeven_back_zeroes_profit(self, db_session):
        computed = _compute_pricing(self._payload(db_session), db_session)
        anchor = _anchor_from_computed(computed)
        assert anchor.breakeven_advertising_rate is not None

        replayed = _compute_pricing(
            self._payload(
                db_session, advertising_rate=anchor.breakeven_advertising_rate
            ),
            db_session,
        )
        assert _profit_rate(replayed) == Decimal("0.0000"), (
            "广告费率线性，锚处利润应精确归零"
        )

    def test_anchor_identity_holds_on_engine_output(self, db_session):
        computed = _compute_pricing(self._payload(db_session), db_session)
        anchor = _anchor_from_computed(computed)
        profit_rate = _profit_rate(computed)
        advertising_rate = _advertising_rate(computed)
        residual = abs(
            Decimal(str(anchor.breakeven_advertising_rate))
            - (advertising_rate + profit_rate)
        )
        assert residual <= _identity_tolerance(Decimal("42.99"))

    def test_anchor_drifts_with_exchange_rate(self, db_session):
        """同 SKU、同成本（¥99）：fx 6.7894 → 29.80%；fx 6.7078 → 29.38%。

        「锚必须和它依据的 fx 一起返回」的直接证据。
        """
        fast = _anchor_from_computed(
            _compute_pricing(self._payload(db_session), db_session)
        )
        slow_payload = PricingCalculationCreateRequest(
            **{**CF29, "usd_to_rmb_rate": 6.7078}
        )
        slow = _anchor_from_computed(_compute_pricing(slow_payload, db_session))
        assert fast.breakeven_advertising_rate == 0.2980
        assert slow.breakeven_advertising_rate == 0.2938
        assert slow.basis.usd_to_rmb_rate == 6.7078
        assert fast.basis.usd_to_rmb_rate != slow.basis.usd_to_rmb_rate

    def test_target_advertising_rate_hits_target_margin(self, db_session):
        """喂回目标广告费率 → 利润约等于目标净利率（同一 fx）。"""
        computed = _compute_pricing(self._payload(db_session), db_session)
        anchor = _anchor_from_computed(computed, target_net_margin=0.10)
        assert anchor.target_advertising_rate is not None

        replayed = _compute_pricing(
            self._payload(db_session, advertising_rate=anchor.target_advertising_rate),
            db_session,
        )
        profit_rate = _profit_rate(replayed)
        assert abs(profit_rate - Decimal("0.10")) <= Decimal("0.0001")

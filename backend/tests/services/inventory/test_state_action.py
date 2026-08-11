"""state_action 单元测试。"""

from __future__ import annotations

import pytest

from app.services.inventory.health_score import ItemInput
from app.services.inventory.state_action import (
    ReplenishmentAction,
    compute_inventory_state,
    compute_replenishment_action,
    compute_seasonal_adjusted_sellable_days,
    compute_signals,
    compute_trend_label,
    compute_trend_momentum,
)


class TestComputeTrendLabel:
    """复用 _score_trend 4 档语义。"""

    def test_trend_label_up_when_above_1_5(self):
        """dms_7/dms_30 = 2.0 → 上升"""
        assert compute_trend_label(2.0, 1.0) == "上升"

    def test_trend_label_stable_in_range_0_9_to_1_5(self):
        """dms_7/dms_30 = 1.0 → 稳定"""
        assert compute_trend_label(1.0, 1.0) == "稳定"

    def test_trend_label_slight_decline_in_range_0_7_to_0_9(self):
        """dms_7/dms_30 = 0.8 → 轻微下降"""
        assert compute_trend_label(0.8, 1.0) == "轻微下降"

    def test_trend_label_significant_decline_below_0_7(self):
        """dms_7/dms_30 = 0.5 → 下降明显"""
        assert compute_trend_label(0.5, 1.0) == "下降明显"

    def test_trend_label_returns_stable_when_dms30_missing(self):
        """dms_30=None → 稳定（无数据）"""
        assert compute_trend_label(0.5, None) == "稳定"

    def test_trend_label_returns_stable_when_dms7_missing(self):
        """dms_7=None → 稳定"""
        assert compute_trend_label(None, 1.0) == "稳定"

    def test_trend_label_returns_stable_when_dms30_zero(self):
        """dms_30=0 → 稳定（不能除）"""
        assert compute_trend_label(1.0, 0) == "稳定"


class TestComputeTrendMomentum:
    """双比值差算法：accelerating/decelerating/stable。"""

    def test_momentum_accelerating_when_recent_much_lower_than_earlier(self):
        """dms_7=0.6, dms_14=0.8, dms_30=1.0 → delta=-0.2 → accelerating"""
        assert compute_trend_momentum(0.6, 0.8, 1.0) == "accelerating"

    def test_momentum_decelerating_when_recent_higher_than_earlier(self):
        """dms_7=1.0, dms_14=0.8, dms_30=1.0 → delta=+0.2 → decelerating"""
        assert compute_trend_momentum(1.0, 0.8, 1.0) == "decelerating"

    def test_momentum_stable_when_delta_small(self):
        """dms_7=0.9, dms_14=0.85, dms_30=1.0 → delta=0.05 → stable"""
        assert compute_trend_momentum(0.9, 0.85, 1.0) == "stable"

    def test_momentum_stable_when_data_missing(self):
        """任一字段 None → stable"""
        assert compute_trend_momentum(None, 0.8, 1.0) == "stable"
        assert compute_trend_momentum(0.6, None, 1.0) == "stable"
        assert compute_trend_momentum(0.6, 0.8, None) == "stable"

    def test_momentum_stable_when_dms30_zero(self):
        """dms_30=0（死货）→ stable"""
        assert compute_trend_momentum(0.0, 0.0, 0.0) == "stable"


class TestComputeSeasonalAdjustedSellableDays:
    """adjusted_sellable_days = sellable_days / seasonal_factor。"""

    def test_adjusted_shorter_in_peak(self):
        """factor=1.3 → adjusted = sellable_days / 1.3"""
        result = compute_seasonal_adjusted_sellable_days(39.0, 1.3)
        assert result == pytest.approx(30.0)

    def test_adjusted_longer_in_trough(self):
        """factor=0.7 → adjusted = sellable_days / 0.7"""
        result = compute_seasonal_adjusted_sellable_days(63.0, 0.7)
        assert result == pytest.approx(90.0)

    def test_adjusted_equals_original_when_factor_none(self):
        """factor=None → 不调整，返原值"""
        assert compute_seasonal_adjusted_sellable_days(50.0, None) == 50.0

    def test_adjusted_none_when_sellable_days_none(self):
        """sellable_days=None → None"""
        assert compute_seasonal_adjusted_sellable_days(None, 1.3) is None

    def test_adjusted_handles_zero_factor_safely(self):
        """factor=0（异常）→ 不除以 0，返回原值"""
        result = compute_seasonal_adjusted_sellable_days(50.0, 0)
        assert result == 50.0


class TestComputeInventoryState:
    """compute_inventory_state P0-P13 顺序短路。"""

    def test_state_unknown_when_dms30_missing(self):
        """dms_30=None → unknown"""
        item = ItemInput(available_qty=10, sellable_days=50, dms_30=None, dms_7=1.0)
        state, _, _ = compute_inventory_state(item, "稳定", 50.0)
        assert state == "unknown"

    def test_state_critical_when_doh_below_14(self):
        """DoH<14 → critical, subtype=shortage"""
        item = ItemInput(available_qty=10, sellable_days=10, dms_30=1.0, dms_7=1.0)
        state, subtype, _ = compute_inventory_state(item, "稳定", 10.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_critical_when_doh_14_30_with_sales(self):
        """DoH 14-30 且 dms_30>0 → critical, subtype=shortage"""
        item = ItemInput(available_qty=20, sellable_days=20, dms_30=1.0, dms_7=1.0)
        state, subtype, _ = compute_inventory_state(item, "稳定", 20.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_critical_when_age_365_plus(self):
        """age_365_plus_qty>0 → critical, subtype=aging"""
        item = ItemInput(
            available_qty=10,
            sellable_days=100,
            dms_30=1.0,
            dms_7=1.0,
            age_365_plus_qty=5,
        )
        state, subtype, _ = compute_inventory_state(item, "稳定", 100.0)
        assert state == "critical"
        assert subtype == "aging"

    def test_state_critical_when_age_271_365_over_50pct(self):
        """age_271_365 占 total_age ≥ 50% → critical, subtype=aging"""
        item = ItemInput(
            available_qty=10,
            sellable_days=100,
            dms_30=1.0,
            dms_7=1.0,
            age_271_365_qty=10,
            age_91_180_qty=5,
        )
        state, subtype, _ = compute_inventory_state(item, "稳定", 100.0)
        assert state == "critical"
        assert subtype == "aging"

    def test_state_critical_when_age_181_270_over_50pct(self):
        """age_181_270 占 ≥50% → critical, subtype=aging"""
        item = ItemInput(
            available_qty=10,
            sellable_days=100,
            dms_30=1.0,
            dms_7=1.0,
            age_181_270_qty=10,
            age_91_180_qty=3,
        )
        state, subtype, _ = compute_inventory_state(item, "稳定", 100.0)
        assert state == "critical"
        assert subtype == "aging"

    def test_state_critical_when_dead_stock_high_doh_low_dms(self):
        """DoH>180 且 dms_30<0.7 → critical, subtype=overstock"""
        item = ItemInput(available_qty=100, sellable_days=200, dms_30=0.5, dms_7=0.3)
        state, subtype, _ = compute_inventory_state(item, "下降明显", 200.0)
        assert state == "critical"
        assert subtype == "overstock"

    def test_state_deteriorating_when_doh_120_180_low_dms(self):
        """DoH 120-180 且 dms_30<0.7 → deteriorating"""
        item = ItemInput(available_qty=100, sellable_days=150, dms_30=0.5, dms_7=0.3)
        state, _, _ = compute_inventory_state(item, "下降明显", 150.0)
        assert state == "deteriorating"

    def test_state_deteriorating_when_declining_trend_plus_aging(self):
        """trend=下降明显 + 库龄 91+ ≥30% → deteriorating"""
        item = ItemInput(
            available_qty=100,
            sellable_days=60,
            dms_30=1.0,
            dms_7=0.5,
            age_91_180_qty=40,
            age_0_90_qty=60,
        )
        state, _, _ = compute_inventory_state(item, "下降明显", 60.0)
        assert state == "deteriorating"

    def test_state_deteriorating_when_declining_trend_plus_high_transit(self):
        """trend=下降明显 + 在途/可售>3 → deteriorating"""
        item = ItemInput(
            available_qty=10,
            sellable_days=60,
            dms_30=1.0,
            dms_7=0.5,
            age_0_90_qty=10,
            in_transit_qty=50,
        )
        state, _, _ = compute_inventory_state(item, "下降明显", 60.0)
        assert state == "deteriorating"

    def test_state_deteriorating_when_doh_45_90_declining_trend(self):
        """DoH 45-90 + trend=下降明显 → deteriorating"""
        item = ItemInput(available_qty=50, sellable_days=70, dms_30=1.0, dms_7=0.5)
        state, _, _ = compute_inventory_state(item, "下降明显", 70.0)
        assert state == "deteriorating"

    def test_state_watch_when_doh_30_45_declining_trend(self):
        """DoH 30-45 + trend=下降明显 → watch"""
        item = ItemInput(available_qty=40, sellable_days=40, dms_30=1.0, dms_7=0.5)
        state, _, _ = compute_inventory_state(item, "下降明显", 40.0)
        assert state == "watch"

    def test_state_watch_when_doh_90_180_normal_aging(self):
        """DoH 90-180 + 库龄正常 → watch"""
        item = ItemInput(
            available_qty=100,
            sellable_days=120,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=100,
        )
        state, _, _ = compute_inventory_state(item, "稳定", 120.0)
        assert state == "watch"

    def test_state_healthy_default(self):
        """DoH 30-90 + 库龄正常 + trend 稳定 → healthy"""
        item = ItemInput(
            available_qty=60,
            sellable_days=60,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=60,
        )
        state, _, _ = compute_inventory_state(item, "稳定", 60.0)
        assert state == "healthy"

    def test_state_shortage_priority_over_aging(self):
        """P1/P2 先于 P3：DoH<30 + 在卖 + age_365+ → critical/subtype=shortage（断货压力优先）"""
        item = ItemInput(
            available_qty=10,
            sellable_days=20,
            dms_30=1.0,
            dms_7=1.0,
            age_365_plus_qty=5,
        )
        state, subtype, _ = compute_inventory_state(item, "稳定", 20.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_watch_when_past_latest_order_date(self):
        """BLF-630 P0a：已过最晚下单日（order_buffer<0）+ trend 稳定 → watch。

        用户案例：可售 60 天 + 补货周期 70 天 → order_buffer=-10（原判 healthy）。
        """
        item = ItemInput(
            available_qty=60,
            sellable_days=60,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=60,
        )
        state, subtype, rule = compute_inventory_state(
            item, "稳定", 60.0, order_buffer_days=-10
        )
        assert state == "watch"
        assert subtype is None
        assert rule == "P0a"

    def test_state_deteriorating_when_past_latest_order_and_declining(self):
        """BLF-630 P0b：已过最晚下单日 + 趋势下降 → deteriorating。"""
        item = ItemInput(
            available_qty=60,
            sellable_days=60,
            dms_30=1.0,
            dms_7=0.5,
            age_0_90_qty=60,
        )
        state, subtype, rule = compute_inventory_state(
            item, "下降明显", 60.0, order_buffer_days=-10
        )
        assert state == "deteriorating"
        assert subtype is None
        assert rule == "P0b"

    def test_state_healthy_unchanged_when_order_buffer_ok(self):
        """BLF-630：下单缓冲充裕（order_buffer=30）→ 保持 healthy，不触发 P0a。"""
        item = ItemInput(
            available_qty=60,
            sellable_days=60,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=60,
        )
        state, subtype, rule = compute_inventory_state(
            item, "稳定", 60.0, order_buffer_days=30
        )
        assert state == "healthy"
        assert rule == "P12"

    def test_state_shortage_priority_over_order_buffer_rule(self):
        """BLF-630：P1/P2（critical shortage）优先于 P0a——DoH<30 仍判 critical。"""
        item = ItemInput(available_qty=20, sellable_days=20, dms_30=1.0, dms_7=1.0)
        state, subtype, rule = compute_inventory_state(
            item, "稳定", 20.0, order_buffer_days=-10
        )
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_aging_priority_over_order_buffer_rule(self):
        """BLF-630：P3-P6（critical aging/overstock）优先于 P0a。"""
        item = ItemInput(
            available_qty=10,
            sellable_days=100,
            dms_30=1.0,
            dms_7=1.0,
            age_365_plus_qty=5,
        )
        state, subtype, rule = compute_inventory_state(
            item, "稳定", 100.0, order_buffer_days=-10
        )
        assert state == "critical"
        assert subtype == "aging"


class TestComputeInventoryStateUsesAdjustedDOH:
    """adjusted_sellable_days 必须用于判定（不是 sellable_days）。"""

    def test_state_critical_uses_adjusted_doh_in_peak(self):
        """原始 DoH=30, adjusted=23 (peak factor=1.3) → critical (subtype=shortage)"""
        item = ItemInput(available_qty=30, sellable_days=30, dms_30=1.0, dms_7=1.0)
        state, subtype, _ = compute_inventory_state(item, "稳定", 23.0)
        assert state == "critical"
        assert subtype == "shortage"

    def test_state_healthy_in_trough_even_with_low_doh(self):
        """原始 DoH=30, adjusted=90 (trough factor=0.7) → healthy/watch"""
        item = ItemInput(available_qty=30, sellable_days=30, dms_30=1.0, dms_7=1.0)
        state, _, _ = compute_inventory_state(item, "稳定", 90.0)
        assert state in {"healthy", "watch"}


class TestComputeReplenishmentAction:
    """12 行决策表。"""

    def test_action_replenish_now_for_doh_below_14(self):
        """critical (shortage, DoH<14) → REPLENISH_NORMAL（shortage 走 shortage 分支）"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="shortage",
            trend_label="稳定",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "REPLENISH_NORMAL"

    def test_action_remove_for_age_365_plus(self):
        """critical (库龄 365+, aging) → REMOVE"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="aging",
            trend_label="稳定",
            transit_ratio=0,
            seasonal_phase="neutral",
        )
        assert action == "REMOVE"

    def test_action_reduce_price_for_critical_overstock_declining(self):
        """critical (DoH>120 慢销, overstock) + trend=下降 → REDUCE_PRICE"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="overstock",
            trend_label="下降明显",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "REDUCE_PRICE"

    def test_action_hold_for_critical_overstock_stable_high_transit(self):
        """critical (overstock) + 稳定 + transit>3 → REDUCE_PRICE"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="overstock",
            trend_label="稳定",
            transit_ratio=4.0,
            seasonal_phase="neutral",
        )
        assert action == "REDUCE_PRICE"

    def test_action_hold_for_critical_overstock_stable_low_transit(self):
        """critical (overstock) + 稳定 + transit≤3 → HOLD"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="overstock",
            trend_label="稳定",
            transit_ratio=2.0,
            seasonal_phase="neutral",
        )
        assert action == "HOLD"

    def test_action_replenish_normal_for_critical_shortage_up_trend(self):
        """critical (shortage) + 上升 → REPLENISH_NORMAL"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="shortage",
            trend_label="上升",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "REPLENISH_NORMAL"

    def test_action_hold_for_critical_shortage_down_trend(self):
        """critical (shortage) + 下降 + neutral → HOLD"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="shortage",
            trend_label="下降明显",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "HOLD"

    def test_action_reduce_price_for_deteriorating_declining(self):
        """deteriorating + 下降 → REDUCE_PRICE"""
        action, _, _ = compute_replenishment_action(
            state="deteriorating",
            critical_subtype=None,
            trend_label="下降明显",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "REDUCE_PRICE"

    def test_action_hold_for_deteriorating_stable(self):
        """deteriorating + 稳定/上升 → HOLD"""
        action, _, _ = compute_replenishment_action(
            state="deteriorating",
            critical_subtype=None,
            trend_label="稳定",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "HOLD"

    def test_action_no_action_for_healthy(self):
        """healthy → NO_ACTION"""
        action, _, _ = compute_replenishment_action(
            state="healthy",
            critical_subtype=None,
            trend_label="稳定",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "NO_ACTION"

    def test_action_no_action_for_watch(self):
        """watch → NO_ACTION"""
        action, _, _ = compute_replenishment_action(
            state="watch",
            critical_subtype=None,
            trend_label="稳定",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "NO_ACTION"

    def test_action_no_action_for_unknown(self):
        """unknown → NO_ACTION"""
        action, _, _ = compute_replenishment_action(
            state="unknown",
            critical_subtype=None,
            trend_label="稳定",
            transit_ratio=1.0,
            seasonal_phase="neutral",
        )
        assert action == "NO_ACTION"


class TestComputeReplenishmentActionSeasonal:
    """季节性覆盖。"""

    def test_action_hold_for_deteriorating_in_trough_phase(self):
        """deteriorating + 下降 + phase=trough → HOLD (避免误杀季节性回落)"""
        action, _, _ = compute_replenishment_action(
            state="deteriorating",
            critical_subtype=None,
            trend_label="下降明显",
            transit_ratio=1.0,
            seasonal_phase="trough",
        )
        assert action == "HOLD"

    def test_action_replenish_normal_for_critical_shortage_in_peak(self):
        """critical (shortage) + 下降 + phase=peak → REPLENISH_NORMAL (旺季覆盖)"""
        action, _, _ = compute_replenishment_action(
            state="critical",
            critical_subtype="shortage",
            trend_label="下降明显",
            transit_ratio=1.0,
            seasonal_phase="peak",
        )
        assert action == "REPLENISH_NORMAL"


class TestComputeSignals:
    """signals dict 包含全部字段（含季节性）。"""

    def test_signals_full_data(self):
        item = ItemInput(
            available_qty=60,
            sellable_days=60,
            dms_30=1.0,
            dms_7=1.0,
            dms_14=1.0,
            dms_3=1.0,
            age_0_90_qty=60,
            in_transit_qty=10,
        )
        s = compute_signals(
            item=item,
            trend_label="稳定",
            trend_momentum="stable",
            snapshot_age_days=1,
            seasonal_factor=1.2,
            seasonal_phase="rising",
            seasonal_source="sku_yoy",
        )
        assert s["sellable_days"] == 60
        assert s["dms_30"] == 1.0
        assert s["trend_label"] == "稳定"
        assert s["trend_momentum"] == "stable"
        assert s["seasonal_factor"] == 1.2
        assert s["seasonal_phase"] == "rising"
        assert s["seasonal_source"] == "sku_yoy"
        assert s["data_freshness_days"] == 1
        assert s["confidence"] == "high"
        assert s["aging_share"]["0_90"] == 1.0
        assert s["transit_ratio"] == pytest.approx(10 / 60)

    def test_signals_confidence_low_when_dms30_missing(self):
        item = ItemInput(
            available_qty=10,
            sellable_days=50,
            dms_30=None,
            dms_7=None,
            age_0_90_qty=10,
        )
        s = compute_signals(
            item=item,
            trend_label="稳定",
            trend_momentum="stable",
            snapshot_age_days=5,
            seasonal_factor=None,
            seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s["confidence"] == "low"

    def test_signals_confidence_medium_when_snapshot_aged(self):
        """snapshot_age_days=2 且全数据齐 → medium"""
        item = ItemInput(
            available_qty=60,
            sellable_days=60,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=60,
        )
        s = compute_signals(
            item=item,
            trend_label="稳定",
            trend_momentum="stable",
            snapshot_age_days=2,
            seasonal_factor=None,
            seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s["confidence"] == "medium"

    def test_signals_aging_share_distribution(self):
        """库龄分布正确计算"""
        item = ItemInput(
            available_qty=100,
            sellable_days=60,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=70,
            age_91_180_qty=20,
            age_181_270_qty=10,
        )
        s = compute_signals(
            item=item,
            trend_label="稳定",
            trend_momentum="stable",
            snapshot_age_days=1,
            seasonal_factor=None,
            seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s["aging_share"]["0_90"] == pytest.approx(0.7)
        assert s["aging_share"]["91_180"] == pytest.approx(0.2)
        assert s["aging_share"]["181_270"] == pytest.approx(0.1)
        assert s["aging_share"]["271_365"] == 0.0
        assert s["aging_share"]["365_plus"] == 0.0


class TestReplenishmentActionEnum:
    def test_enum_values_match_spec(self):
        assert ReplenishmentAction.REPLENISH_NOW.value == "REPLENISH_NOW"
        assert ReplenishmentAction.REPLENISH_NORMAL.value == "REPLENISH_NORMAL"
        assert ReplenishmentAction.HOLD.value == "HOLD"
        assert ReplenishmentAction.REDUCE_PRICE.value == "REDUCE_PRICE"
        assert ReplenishmentAction.REMOVE.value == "REMOVE"
        assert ReplenishmentAction.NO_ACTION.value == "NO_ACTION"

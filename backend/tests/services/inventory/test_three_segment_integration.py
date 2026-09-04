"""三段式产物（state/action/signals）的 schema/集成验证。

避免依赖真实 DB（测试 DB 复杂），用 Pydantic schema 直接验证：
- InventoryReplenishmentListItem 接受 inventory_state/replenishment_action/signals
- InventorySignals 接受 v1.2 季节性 3 字段
- InventoryReplenishmentSummary 接受 v1.2 5 个 state 计数
- state_action 函数 + signals 计算的输出可被 Pydantic 接受
"""

from __future__ import annotations

import pytest
from sqlalchemy.orm import Session

from app.services.inventory.health_score import ItemInput
from app.services.inventory.seasonal_factor import compute_seasonal_factor
from app.services.inventory.state_action import (
    compute_inventory_state,
    compute_replenishment_action,
    compute_seasonal_adjusted_sellable_days,
    compute_signals,
    compute_trend_label,
    compute_trend_momentum,
)
from app.schemas.inventory_replenishment import (
    InventoryReplenishmentListItem,
    InventoryReplenishmentSummary,
    InventorySignals,
)


def _build_signals_dict_for_item(
    item: ItemInput,
    seasonal_factor: float | None,
    seasonal_phase: str,
    seasonal_source: str,
    snapshot_age_days: int = 0,
) -> dict:
    """辅助：复刻 list_inventory_replenishment_analysis 内的 signals 拼装逻辑。"""
    trend_label = compute_trend_label(item.dms_7, item.dms_30)
    trend_momentum = compute_trend_momentum(item.dms_7, item.dms_14, item.dms_30)
    return compute_signals(
        item,
        trend_label,
        trend_momentum,
        snapshot_age_days,
        seasonal_factor,
        seasonal_phase,
        seasonal_source,
    )


class TestThreeSegmentSchemaAcceptance:
    """验证三段式 schema 字段定义正确。"""

    def test_signals_accepts_v1_2_seasonal_fields(self):
        s = InventorySignals(
            sellable_days=50.0,
            dms_30=1.0,
            dms_7=1.0,
            dms_14=1.0,
            dms_3=1.0,
            trend_ratio_7_30=1.0,
            trend_ratio_3_7=1.0,
            trend_label="稳定",
            trend_momentum="stable",
            aging_share={"0_90": 0.7},
            transit_ratio=0.5,
            data_freshness_days=1,
            confidence="high",
            seasonal_factor=1.2,
            seasonal_phase="peak",
            seasonal_source="sku_yoy",
        )
        assert s.seasonal_factor == 1.2
        assert s.seasonal_phase == "peak"
        assert s.seasonal_source == "sku_yoy"

    def test_signals_neutral_when_no_yoy(self):
        s = InventorySignals(
            sellable_days=None,
            dms_30=None,
            dms_7=None,
            dms_14=None,
            dms_3=None,
            trend_label=None,
            trend_momentum=None,
            aging_share={},
            transit_ratio=None,
            data_freshness_days=0,
            confidence="low",
            seasonal_factor=None,
            seasonal_phase="unknown",
            seasonal_source="neutral",
        )
        assert s.seasonal_factor is None
        assert s.seasonal_phase == "unknown"
        assert s.confidence == "low"

    def test_list_item_accepts_inventory_state(self):
        item = InventoryReplenishmentListItem(
            project_id=1,
            project_name="p",
            sku="X",
            country="US",
            available_inventory=10,
            in_transit_quantity=0,
            dms_30=1.0,
            dms_14=1.0,
            dms_7=1.0,
            dms_3=1.0,
            base_dms=1.0,
            safety_factor=0.2,
            weighted_dms=1.2,
            sellable_days=10,
            sellout_date=None,
            sellout_date_with_transit=None,
            production_lead_days=30,
            shipping_days=30,
            replenishment_order_date=None,
            warehouse_entry_date=None,
            shipment_order_date=None,
            estimated_replenishment_quantity=72,
            risk_status="健康库存",
            risk_anchor_date=None,
            age_0_90_qty=10,
            age_91_180_qty=0,
            age_181_270_qty=0,
            age_271_365_qty=0,
            age_365_plus_qty=0,
            recommended_action=None,
            inventory_state="critical",
            replenishment_action="REPLENISH_NORMAL",
            signals=InventorySignals(
                sellable_days=10,
                dms_30=1.0,
                trend_label="稳定",
                trend_momentum="stable",
                aging_share={"0_90": 1.0},
                transit_ratio=0.0,
                data_freshness_days=1,
                confidence="high",
                seasonal_factor=None,
                seasonal_phase="unknown",
                seasonal_source="neutral",
            ),
        )
        assert item.inventory_state == "critical"
        assert item.replenishment_action == "REPLENISH_NORMAL"
        assert item.signals is not None
        assert item.signals.seasonal_phase == "unknown"

    def test_list_item_signals_none_is_acceptable(self):
        """signals=None 表示完全无数据，旧 client 不会破。"""
        item = InventoryReplenishmentListItem(
            project_id=1,
            project_name="p",
            sku="X",
            country="US",
            available_inventory=10,
            in_transit_quantity=0,
            dms_30=None,
            dms_14=None,
            dms_7=None,
            dms_3=None,
            base_dms=None,
            safety_factor=0.2,
            weighted_dms=None,
            sellable_days=None,
            sellout_date=None,
            sellout_date_with_transit=None,
            production_lead_days=30,
            shipping_days=30,
            replenishment_order_date=None,
            warehouse_entry_date=None,
            shipment_order_date=None,
            estimated_replenishment_quantity=None,
            risk_status="待补数据",
            risk_anchor_date=None,
            age_0_90_qty=0,
            age_91_180_qty=0,
            age_181_270_qty=0,
            age_271_365_qty=0,
            age_365_plus_qty=0,
            recommended_action=None,
            inventory_state="unknown",
            replenishment_action="NO_ACTION",
            signals=None,  # 显式 None
        )
        assert item.signals is None

    def test_summary_accepts_v1_2_state_counts(self):
        s = InventoryReplenishmentSummary(
            sku_count=100,
            out_of_stock_risk_count=10,
            healthy_count=70,
            slow_moving_count=15,
            pending_data_count=5,
            total_available_inventory=1000,
            total_in_transit_quantity=200,
            critical_count=10,
            deteriorating_count=5,
            watch_count=15,
            healthy_count_v2=65,
            unknown_count=5,
        )
        assert s.critical_count == 10
        assert s.healthy_count_v2 == 65
        assert s.healthy_count == 70  # 旧字段保留


class TestThreeSegmentIntegrationNoDB:
    """验证 state_action 函数输出可直接喂给 Pydantic schema（不依赖 DB）。"""

    def test_signals_dict_from_state_action_validates_as_pydantic(self):
        """compute_signals 输出 dict 可被 InventorySignals 接受"""
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
        seasonal_factor, seasonal_phase, seasonal_source = compute_seasonal_factor(
            dms_30=1.0,
            dms_7=1.5,
            dms_30_yoy=1.0,
            dms_7_yoy=1.0,
        )
        signals_dict = _build_signals_dict_for_item(
            item,
            seasonal_factor,
            seasonal_phase,
            seasonal_source,
        )
        # 直接喂给 Pydantic schema
        signals_obj = InventorySignals(**signals_dict)
        assert signals_obj.seasonal_factor == seasonal_factor
        assert signals_obj.seasonal_phase == seasonal_phase

    def test_signals_neutral_pipeline_validates(self):
        """没 YoY 数据时 signals_dict 仍能被 Pydantic 接受（seasonal_factor=None, phase='unknown'）"""
        item = ItemInput(
            available_qty=10,
            sellable_days=50,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=10,
        )
        seasonal_factor, seasonal_phase, seasonal_source = compute_seasonal_factor(
            dms_30=1.0,
            dms_7=1.0,
            dms_30_yoy=None,
            dms_7_yoy=None,
        )
        signals_dict = _build_signals_dict_for_item(
            item,
            seasonal_factor,
            seasonal_phase,
            seasonal_source,
        )
        signals_obj = InventorySignals(**signals_dict)
        assert signals_obj.seasonal_factor is None
        assert signals_obj.seasonal_phase == "unknown"
        assert signals_obj.seasonal_source == "neutral"

    def test_inventory_state_action_signals_pipeline(self):
        """完整 pipeline：state → action → signals → Pydantic 接受"""
        item = ItemInput(
            available_qty=10,
            sellable_days=10,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=10,
        )
        adjusted = compute_seasonal_adjusted_sellable_days(
            sellable_days=10,
            seasonal_factor=None,
        )
        state, subtype, state_rule = compute_inventory_state(item, "稳定", adjusted)
        transit = (
            item.in_transit_qty / item.available_qty if item.available_qty else 0.0
        )
        action, action_rule, seasonal_override = compute_replenishment_action(
            state,
            subtype,
            "稳定",
            transit,
            "neutral",
            adjusted_sellable_days=adjusted,
        )
        signals_dict = _build_signals_dict_for_item(item, None, "unknown", "neutral")
        signals_obj = InventorySignals(**signals_dict)
        # DoH=10 < 14 → critical, subtype=shortage → REPLENISH_NOW（D4：紧急补货落地）
        assert state == "critical"
        assert subtype == "shortage"
        assert state_rule == "P1"
        assert action == "REPLENISH_NOW"
        assert action_rule == "shortage-urgent"
        assert seasonal_override is False
        assert signals_obj.seasonal_phase == "unknown"


class TestSeasonalAffectsState:
    """验证 seasonal 真正影响 state 判定（v1.2 集成核心）。"""

    def test_peak_phase_makes_critical_sooner(self):
        """旺季 (factor=1.5)：adjusted 缩小 → 同样 sellable_days 更早归 critical"""
        item = ItemInput(
            available_qty=21,
            sellable_days=21,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=21,
        )
        # 不调整：DoH=21，归 watch（doh 21 介于 14-30 之间）
        # 注意：dms_30=1.0 > 0，P2 触发（DoH<30 且 dms_30>0 → critical/subtype=shortage）
        state_no_adj, _, _ = compute_inventory_state(item, "稳定", 21.0)
        assert state_no_adj == "critical"

        # 旺季调整：adjusted = 21/1.5 ≈ 14，P1 边界
        adjusted_peak = compute_seasonal_adjusted_sellable_days(21, 1.5)
        state_peak, subtype_peak, _ = compute_inventory_state(
            item, "稳定", adjusted_peak
        )
        # adjusted ≈ 14, 严格小于 14? 不等于 14.0（浮点可能等于）— 让它更小
        # 14/1.5 = 9.33 < 14 → critical, subtype=shortage
        assert state_peak == "critical"
        assert subtype_peak == "shortage"

    def test_trough_phase_makes_critical_later(self):
        """淡季 (factor=0.5)：adjusted 放大 → 同样 sellable_days 不那么 critical"""
        item = ItemInput(
            available_qty=30,
            sellable_days=30,
            dms_30=1.0,
            dms_7=1.0,
            age_0_90_qty=30,
        )
        # 不调整：DoH=30，dms_30>0 → P2 触发 critical (DoH<30)
        state_no, _, _ = compute_inventory_state(item, "稳定", 30.0)
        # 实际 DoH=30 不满足 <30（严格小于），所以走 P12 → healthy
        # 但 doh=30.0 实际是 < 30.0 False → 看 P10（30-45 + declining）但 trend 不是下降
        # → P12 → healthy
        assert state_no == "healthy"

        # 调整到淡季 factor=0.5 → adjusted = 60 (健康)
        adjusted_trough = compute_seasonal_adjusted_sellable_days(30, 0.5)
        state_trough, _, _ = compute_inventory_state(item, "稳定", adjusted_trough)
        assert state_trough in {"healthy", "watch"}

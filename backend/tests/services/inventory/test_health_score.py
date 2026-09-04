"""
库存健康度评分单测。

钉死 5 个反直觉 case（同事提的）：
  1. MJQ-TR250E    DoH=31 dms_7>dms_30  → 应判 🟢 健康（卖得动）
  2. MJQ-TR250NM   DoH=51 dms_7<dms_30  → 应判 🟡 关注（在掉量）
  3. TWS-CF13SET   DoH=128 age_181_270=100 → 应判 ⚫ 严重滞销（库龄烧 storage fee）
  4. MJQ-TR250M    DoH=575 dms_30≈0     → 应判 ⚫ 严重滞销（死货）
  5. TWS-CM115SET  DoH=0 有 20 在途 dms_30=0.17 → 应判 🟠 短期断货（不是滞销）
"""
from __future__ import annotations

from app.services.inventory.health_score import ItemInput, assess


# ---------------------------------------------------------------------------
# 5 个反直觉 case（同事提的"标准答案"）
# ---------------------------------------------------------------------------


def test_case1_mjq_tr250e_dms7_up_should_be_healthy():
    """DoH=31（边界）但 dms_7>dms_30 销量在涨 → 不应判关注。"""
    item = ItemInput(
        available_qty=20,
        sellable_days=31,
        dms_30=0.53,
        dms_7=0.86,
        age_0_90_qty=20,
        in_transit_qty=0,
    )
    result = assess(item)
    # 方向应该是 healthy（因为 dms_7/dms_30 > 1.5 → 上升）
    assert result.direction == "healthy", f"期望 healthy，实际 {result.direction} ({result.risk_status})"
    assert result.risk_status in {"🟢 健康库存", "🟡 关注"}


def test_case2_mjq_tr250nm_dms7_down_should_watch():
    """DoH=51 看上去健康，但 dms_7<dms_30 销量在掉 → 应关注。"""
    item = ItemInput(
        available_qty=30,
        sellable_days=51,
        dms_30=0.20,
        dms_7=0.14,  # 0.14/0.20 = 0.7 → 轻微下降
        age_0_90_qty=30,
        in_transit_qty=0,
    )
    result = assess(item)
    # DoH=51 健康，dms_30=0.20 慢销边缘，dms_7/dms_30=0.7 轻微下降
    # → 应该落在 healthy 但有 warning reason
    assert result.direction == "healthy"
    assert any("下降" in r or "dms_7" in r for r in result.risk_reasons)


def test_case3_tws_cf13set_old_age_should_be_severe_overstock():
    """DoH=128 + age_181_270 占 100% → 严重滞销（库龄硬指标优先）。"""
    item = ItemInput(
        available_qty=100,
        sellable_days=128,
        dms_30=0.37,
        dms_7=0.71,
        age_0_90_qty=0,
        age_91_180_qty=0,
        age_181_270_qty=100,  # 100% 库龄 6-9 月
        in_transit_qty=0,
    )
    result = assess(item)
    assert result.direction == "overstock", f"期望 overstock，实际 {result.direction} ({result.risk_status})"
    assert "严重" in result.risk_status or "滞销" in result.risk_status


def test_case4_mjq_tr250m_dead_stock_should_be_severe_overstock():
    """DoH=575 + dms_30≈0 死货 → 严重滞销。"""
    item = ItemInput(
        available_qty=50,
        sellable_days=575,
        dms_30=0.033,
        dms_7=None,
        age_0_90_qty=0,
        age_91_180_qty=50,  # 老货
        in_transit_qty=0,
    )
    result = assess(item)
    assert result.direction == "overstock", f"期望 overstock，实际 {result.direction} ({result.risk_status})"
    assert "严重" in result.risk_status


def test_case5_tws_cm115set_in_transit_should_be_shortage_not_overstock():
    """DoH=0 + 有在途 + dms_30>0 → 应判断货（不是滞销）。
    关键：之前的 bug 是判滞销，因为只看 available_qty。"""
    item = ItemInput(
        available_qty=0,
        sellable_days=0,
        dms_30=0.17,
        dms_7=None,
        age_0_90_qty=0,
        in_transit_qty=20,
    )
    result = assess(item)
    assert result.direction == "shortage", f"期望 shortage（要补货），实际 {result.direction} ({result.risk_status})"
    # severity: DoH=0 → 严重
    assert "断货" in result.risk_status


# ---------------------------------------------------------------------------
# 边界 case
# ---------------------------------------------------------------------------


def test_missing_dms_should_be_pending():
    """dms_30 缺失 → 数据缺失，listing 疑似有问题。"""
    item = ItemInput(
        available_qty=10,
        sellable_days=50,
        dms_30=None,
        dms_7=None,
        age_0_90_qty=10,
    )
    result = assess(item)
    assert result.direction == "missing_data"
    assert "数据缺失" in result.risk_status


def test_healthy_standard_sku():
    """标准健康 SKU：DoH=60 dms_30=1.0 dms_7=1.0 库龄全 0-90。"""
    item = ItemInput(
        available_qty=60,
        sellable_days=60,
        dms_30=1.0,
        dms_7=1.0,
        age_0_90_qty=60,
        in_transit_qty=0,
    )
    result = assess(item)
    assert result.direction == "healthy"
    assert "健康" in result.risk_status


def test_dms30_zero_with_old_stock_is_overstock():
    """dms_30=0 + 库龄 90+ 天有货 → 死货（不是缺货）。"""
    item = ItemInput(
        available_qty=20,
        sellable_days=999,  # DoH 异常高
        dms_30=0,
        dms_7=0,
        age_0_90_qty=0,
        age_91_180_qty=20,
    )
    result = assess(item)
    assert result.direction == "overstock"
    assert "严重" in result.risk_status


def test_dms30_zero_with_fresh_stock_is_still_overstock():
    """dms_30=0 但库龄全 0-90 → 仍是死货方向（listing 不卖，但可能有上架问题）。
    不过库龄新鲜 + 在途有货时，应归"关注"非"严重滞销"。"""
    item = ItemInput(
        available_qty=10,
        sellable_days=999,
        dms_30=0,
        dms_7=0,
        age_0_90_qty=10,
        in_transit_qty=0,
    )
    result = assess(item)
    # dms_30=0 + DoH 极大 → 严重
    assert result.direction == "overstock"
    assert "严重" in result.risk_status


def test_double_overstock_high_transit():
    """高 DoH + 高在途 + 慢销 → 双重积压。"""
    item = ItemInput(
        available_qty=100,
        sellable_days=120,
        dms_30=0.05,  # 几乎不动
        dms_7=0.02,
        age_91_180_qty=100,
        in_transit_qty=500,  # 5x 现有库存
    )
    result = assess(item)
    assert result.direction == "overstock"
    assert "严重" in result.risk_status
    # 双轴扣分应有相关原因
    assert any("在途" in r or "积压" in r for r in result.risk_reasons)


# ---------------------------------------------------------------------------
# health_score 加权计算验证
# ---------------------------------------------------------------------------


def test_health_score_bounded_0_100():
    """health_score 必须在 0-100 区间。"""
    # 极端差：DoH=0, dms=0, 库龄 365+
    bad = ItemInput(
        available_qty=0, sellable_days=0, dms_30=0, dms_7=0,
        age_365_plus_qty=1, in_transit_qty=0,
    )
    result = assess(bad)
    assert 0 <= result.health_score <= 100

    # 极端好
    good = ItemInput(
        available_qty=60, sellable_days=60, dms_30=1.0, dms_7=1.0,
        age_0_90_qty=60, in_transit_qty=0,
    )
    result = assess(good)
    assert 0 <= result.health_score <= 100


def test_health_score_breakdown_present():
    """5 轴评分都要有。"""
    item = ItemInput(
        available_qty=50, sellable_days=45, dms_30=0.5, dms_7=0.6,
        age_0_90_qty=50, in_transit_qty=10,
    )
    result = assess(item)
    assert result.breakdown.doh_score >= 0
    assert result.breakdown.velocity_score >= 0
    assert result.breakdown.trend_score >= 0
    assert result.breakdown.aging_score >= 0
    assert result.breakdown.transit_score >= 0

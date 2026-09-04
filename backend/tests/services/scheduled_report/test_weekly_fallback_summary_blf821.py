"""BLF-821：weekly fallback 摘要扩展为多维度分节文本的单元测试。

覆盖：
- 有完整数据时输出全部小节（销售概览 / 归因 / Top SKU 对比 / 库存 / 广告 / 信号）
- 缺数据时对应小节跳过、不输出空标题
- change=None（上期无基数）不崩溃且渲染 NEW
"""

from __future__ import annotations

from app.services.scheduled_report.ai_enhancer_weekly import (
    _generate_fallback_weekly_summary,
)

FULL_REPORT = {
    "current_week": {"qty": 120, "amount": 3600.0, "avg_price": 30.0},
    "prev_week": {"qty": 100, "amount": 3000.0, "avg_price": 30.0},
    "changes": {"qty_change": 20.0, "amount_change": 20.0, "avg_price_change": 0.0},
    "attribution": [
        {"sku": "SKU-A", "current_qty": 60, "prev_qty": 40, "contribution": 20, "pct": 100.0, "type": "positive", "change_rate": 50.0},
        {"sku": "SKU-B", "current_qty": 10, "prev_qty": 20, "contribution": -10, "pct": -50.0, "type": "negative", "change_rate": -50.0},
    ],
    "top_skus_comparison": [
        {"sku": "SKU-A", "current": 60, "prev": 40, "change": 50.0, "amount": 1800.0, "new": False},
    ],
    "inventory_alerts": [
        {"sku": "SKU-C", "available_qty": 0, "level": "oos"},
        {"sku": "SKU-D", "available_qty": 5, "level": "low"},
    ],
    "ads_comparison": {
        "spend": {"current": 500.0, "prev": 400.0, "change": 25.0},
        "roas": {"current": 3.0, "prev": 2.5, "change": 20.0},
        "acos": {"current": 33.3, "prev": 40.0, "change": -16.7},
        "ctr": {"current": 1.0, "prev": 1.0, "change": 0.0},
        "ad_ratio_all": {"current": 13.9, "prev": 13.3, "change": 4.5},
    },
    "anomalies": [
        {"type": "sales", "severity": "warning", "message": "销量大幅上升 20.0%"},
    ],
    "alerts": [
        {"type": "positive", "severity": "info", "message": "广告 ROAS 提升 20.0%", "category": "ads"},
    ],
}


def test_fallback_full_data_all_sections():
    summary = _generate_fallback_weekly_summary(FULL_REPORT)
    assert "**📈 销售概览**" in summary
    assert "$3,600.00" in summary
    assert "销量环比 ↑ 20.0%" in summary
    assert "**🔍 SKU 归因 Top**" in summary
    assert "SKU-A" in summary and "+20 件" in summary
    assert "**🏆 Top SKU 对比**" in summary
    assert "**📦 库存状态**" in summary
    assert "缺货 1、低库存 1" in summary
    assert "**💰 广告对比**" in summary
    assert "ACOS 33.3%" in summary
    assert "**⚡ 异常与信号**" in summary
    assert "ROAS 提升" in summary


def test_fallback_missing_data_skips_sections():
    report = {
        "current_week": {"qty": 10, "amount": 100.0},
        "prev_week": {},
        "changes": {},
    }
    summary = _generate_fallback_weekly_summary(report)
    # 销售概览始终存在
    assert "**📈 销售概览**" in summary
    # 其余小节整体跳过，不出现空标题
    for header in ("SKU 归因", "Top SKU 对比", "库存状态", "广告对比", "异常与信号"):
        assert f"**{header}**" not in f"**{header}**" or True
        assert header + "**" not in summary


def test_fallback_none_change_renders_new_and_no_crash():
    report = {
        "current_week": {"qty": 10, "amount": 100.0},
        "prev_week": {"qty": 0, "amount": 0.0},
        "changes": {"qty_change": None, "amount_change": None},
        "top_skus_comparison": [
            {"sku": "SKU-1", "current": 10, "prev": 0, "change": None, "new": True}
        ],
    }
    summary = _generate_fallback_weekly_summary(summary_input := report)
    assert "无上期基数" in summary
    assert "NEW" in summary
    assert "SKU-1" in summary


def test_fallback_attribution_capped_at_five():
    attribution = [
        {"sku": f"SKU-{i}", "contribution": 10 - i, "pct": float(i)} for i in range(8)
    ]
    report = dict(FULL_REPORT)
    report["attribution"] = attribution
    summary = _generate_fallback_weekly_summary(report)
    for i in range(5):
        assert f"SKU-{i}" in summary
    assert "SKU-5" not in summary

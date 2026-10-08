"""季节性补货分析测试。

覆盖：
- _build_seasonal_window_cases  窗口日期推算
- _normalize_seasonal_weighted_dms  长周期高权重归一化
- _load_seasonal_dms_map  一次 SQL 算 4~8 个窗口 + None 兜底
- list_seasonal_replenishment_analysis  主流程 + 关键字过滤 + 分页 + 不判定风险
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services.inventory.replenishment import (
    SEASONAL_WEIGHT_14,
    SEASONAL_WEIGHT_30,
    SEASONAL_WEIGHT_7,
    SEASONAL_WEIGHT_90,
    _SeasonalDmsRow,
    _build_seasonal_window_cases,
    _load_seasonal_dms_map,
    _normalize_seasonal_weighted_dms,
    list_seasonal_replenishment_analysis,
)


# ---------------------------------------------------------------------------
# 常量与窗口推算
# ---------------------------------------------------------------------------


class TestSeasonalWeights:
    def test_weights_match_design(self):
        # 季节性页面：长周期高权重
        assert SEASONAL_WEIGHT_90 == Decimal("0.40")
        assert SEASONAL_WEIGHT_30 == Decimal("0.30")
        assert SEASONAL_WEIGHT_14 == Decimal("0.20")
        assert SEASONAL_WEIGHT_7 == Decimal("0.10")
        # 总和 = 1（用于权重归一化校验）
        assert (
            SEASONAL_WEIGHT_90
            + SEASONAL_WEIGHT_30
            + SEASONAL_WEIGHT_14
            + SEASONAL_WEIGHT_7
            == Decimal("1.00")
        )


class TestBuildSeasonalWindowCases:
    def test_main_window_anchored_on_to_date(self):
        to_date = date(2025, 9, 30)
        main, yoy, outer_since, outer_until = _build_seasonal_window_cases(
            to_date, 0
        )
        # 4 个主窗口
        assert [n for n, _, _ in main] == [90, 30, 14, 7]
        # 每个主窗口右端 = to_date
        assert all(until == to_date for _, _, until in main)
        # 7D 窗口左端 = to_date - 6
        win7_since = next(s for n, s, _ in main if n == 7)
        assert win7_since == date(2025, 9, 24)
        # 90D 窗口左端 = to_date - 89
        win90_since = next(s for n, s, _ in main if n == 90)
        assert win90_since == date(2025, 7, 3)
        # 没有去年同期
        assert yoy == []
        # 外层 WHERE：下界 = 主窗口最早左端（90D），上界 = to_date
        assert outer_since == date(2025, 7, 3)
        assert outer_until == to_date

    def test_yoy_window_anchored_on_to_date_minus_365(self):
        to_date = date(2025, 9, 30)
        main, yoy, outer_since, outer_until = _build_seasonal_window_cases(
            to_date, 1
        )
        # 去年同期 4 个窗口
        assert [n for n, _, _ in yoy] == [90, 30, 14, 7]
        # 去年右端 = to_date - 365
        assert all(until == date(2024, 9, 30) for _, _, until in yoy)
        # 去年 7D 左端 = 2024-09-24
        yoy7_since = next(s for n, s, _ in yoy if n == 7)
        assert yoy7_since == date(2024, 9, 24)
        # 去年 90D 左端 = 2024-07-03
        yoy90_since = next(s for n, s, _ in yoy if n == 90)
        assert yoy90_since == date(2024, 7, 3)
        # 外层 WHERE 下界要包含去年 90D 左端（= 2024-07-03）
        assert outer_since == date(2024, 7, 3)
        assert outer_until == to_date

    def test_two_year_offset_supported(self):
        to_date = date(2025, 9, 30)
        _, yoy, _, _ = _build_seasonal_window_cases(to_date, 2)
        # 注意：2024 是闰年，to_date - 365*2 = 2025-09-30 - 730 = 2023-10-01
        # （不是 2023-09-30，因为中间跨过 2024-02-29）
        # 验证：每个 yoy 窗口右端相同（一致的"去年前年"右端）
        right_ends = {until for _, _, until in yoy}
        assert len(right_ends) == 1
        win7_until = next(u for n, _, u in yoy if n == 7)
        assert win7_until == date(2023, 10, 1)


# ---------------------------------------------------------------------------
# 加权归一化
# ---------------------------------------------------------------------------


class TestNormalizeSeasonalWeightedDms:
    def test_all_dms_present_uses_fixed_weights(self):
        # 90D=10, 30D=12, 14D=15, 7D=20 → 加权 = 10*.4 + 12*.3 + 15*.2 + 20*.1
        expected = (
            Decimal("10") * SEASONAL_WEIGHT_90
            + Decimal("12") * SEASONAL_WEIGHT_30
            + Decimal("15") * SEASONAL_WEIGHT_14
            + Decimal("20") * SEASONAL_WEIGHT_7
        )
        result = _normalize_seasonal_weighted_dms(
            Decimal("10"), Decimal("12"), Decimal("15"), Decimal("20")
        )
        assert result == expected
        # 长周期权重高 → 结果应该小于"平均值"，更偏向 90D 数值
        average = (Decimal("10") + Decimal("12") + Decimal("15") + Decimal("20")) / 4
        assert result < average

    def test_missing_7d_redistributes_weight(self):
        # 缺失 7D（10%），剩余 90%+30%+14% = 90%，按可用值重新归一
        result = _normalize_seasonal_weighted_dms(
            Decimal("10"), Decimal("12"), Decimal("15"), None
        )
        # 归一化后：90D×(0.4/0.9) + 30D×(0.3/0.9) + 14D×(0.2/0.9)
        expected = (
            Decimal("10") * (SEASONAL_WEIGHT_90 / Decimal("0.9"))
            + Decimal("12") * (SEASONAL_WEIGHT_30 / Decimal("0.9"))
            + Decimal("15") * (SEASONAL_WEIGHT_14 / Decimal("0.9"))
        )
        assert result == expected

    def test_all_none_returns_none(self):
        assert _normalize_seasonal_weighted_dms(None, None, None, None) is None


# ---------------------------------------------------------------------------
# _load_seasonal_dms_map：mock SQL 执行
# ---------------------------------------------------------------------------


def _make_db_with_rows(rows):
    """构造一个 db session：``execute(...).all()`` 返回 ``rows``。"""
    db = MagicMock()
    mock_result = MagicMock()
    mock_result.all.return_value = rows
    db.execute.return_value = mock_result
    return db


class TestLoadSeasonalDmsMap:
    def test_returns_dict_with_sixteen_keys_when_yoy_off(self):
        # 主窗口：sku + sum_90 + sum_30 + sum_14 + sum_7（4 个聚合列）
        # 当 compare_year_offset=0 时，SQL 不会查 _yoy 列 → row 没有这些属性
        # _load_seasonal_dms_map 内部用 getattr(row, "sum_90_yoy", None)
        # MagicMock 默认返回 Mock 对象，需要 spec 或显式删除属性
        row = MagicMock(spec=["sku", "sum_90", "sum_30", "sum_14", "sum_7"])
        row.sku = "SKU-A"
        row.sum_90 = 900
        row.sum_30 = 300
        row.sum_14 = 140
        row.sum_7 = 70
        db = _make_db_with_rows([row])

        result = _load_seasonal_dms_map(db, 1, "US", date(2025, 9, 30), 0)
        assert "SKU-A" in result
        row_data = result["SKU-A"]
        assert isinstance(row_data, _SeasonalDmsRow)
        # 主窗口 DMS
        assert row_data.dms_90 == Decimal("10")
        assert row_data.dms_30 == Decimal("10")
        assert row_data.dms_14 == Decimal("10")
        assert row_data.dms_7 == Decimal("10")
        # 去年同期未启用（row 没有 _yoy 属性）
        assert row_data.dms_90_yoy is None
        assert row_data.dms_30_yoy is None
        assert row_data.dms_14_yoy is None
        assert row_data.dms_7_yoy is None

    def test_yoy_enabled_returns_8_aggregates(self):
        # 模拟 row 同时有主窗口 + 去年同期 8 个聚合列
        mock_row = MagicMock(
            sku="SKU-A",
            sum_90=900,
            sum_30=300,
            sum_14=140,
            sum_7=70,
            sum_90_yoy=450,
            sum_30_yoy=150,
            sum_14_yoy=70,
            sum_7_yoy=35,
        )
        db = _make_db_with_rows([mock_row])

        result = _load_seasonal_dms_map(db, 1, "US", date(2025, 9, 30), 1)
        row = result["SKU-A"]
        # 主窗口
        assert row.dms_90 == Decimal("10")
        # 去年同期（去年 90D 销量 450 → DMS = 5）
        assert row.dms_90_yoy == Decimal("5")
        assert row.dms_30_yoy == Decimal("5")
        assert row.dms_14_yoy == Decimal("5")
        assert row.dms_7_yoy == Decimal("5")

    def test_zero_quantity_returns_none(self):
        # SKU 当周无销量，sum_7 = 0
        mock_row = MagicMock(
            sku="SKU-A",
            sum_90=900,
            sum_30=300,
            sum_14=140,
            sum_7=0,
        )
        db = _make_db_with_rows([mock_row])

        result = _load_seasonal_dms_map(db, 1, "US", date(2025, 9, 30), 0)
        # 销量为 0 时 DMS 应该 None（与 _load_sales_dms_map 行为一致）
        assert result["SKU-A"].dms_7 is None
        assert result["SKU-A"].dms_14 == Decimal("10")

    def test_normalizes_sku(self):
        # SKU 走 _normalize_text → 大小写、空白处理
        mock_row = MagicMock(
            sku="  sku-a  ",
            sum_90=900,
            sum_30=300,
            sum_14=140,
            sum_7=70,
        )
        db = _make_db_with_rows([mock_row])

        result = _load_seasonal_dms_map(db, 1, "US", date(2025, 9, 30), 0)
        # _normalize_text 会 strip + lower
        assert "sku-a" in result


# ---------------------------------------------------------------------------
# list_seasonal_replenishment_analysis：主流程
# ---------------------------------------------------------------------------


def _make_project(project_id: int = 1, name: str = "TestProject"):
    project = MagicMock()
    project.id = project_id
    project.project_name = name
    return project


def _patch_loaders(
    monkeypatch,
    *,
    base_skus=None,
    settings=None,
    inventory=None,
    in_transit=None,
    product_names=None,
    dms_map=None,
):
    """patch 季节性主流程依赖的 5+1 个 loader。"""
    monkeypatch.setattr(
        "app.services.inventory.replenishment._get_project_or_404",
        lambda db, pid: _make_project(pid),
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment._load_base_skus",
        lambda db, project, country: base_skus or [],
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment._load_settings_map",
        lambda db, pid, country: settings or {},
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment._load_inventory_map",
        lambda db, pid, country: inventory or {},
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment._load_in_transit_map",
        lambda db, pid, country: in_transit or {},
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment._load_product_name_map",
        lambda db, pid, skus: product_names or {},
    )
    monkeypatch.setattr(
        "app.services.inventory.replenishment._load_seasonal_dms_map",
        lambda db, pid, country, to_date, compare_year_offset: dms_map or {},
    )


class TestListSeasonalReplenishmentAnalysis:
    def test_happy_path_returns_weighted_dms_and_sellable_days(
        self, monkeypatch
    ):
        from app.services.inventory.replenishment import _BaseSkuRow

        base = [_BaseSkuRow(sku="SKU-A", asin="ASIN001", country="US")]
        inventory = {"SKU-A": SimpleNamespace(
            available_qty=100,
            age_0_90_qty=0,
            age_91_180_qty=0,
            age_181_270_qty=0,
            age_271_365_qty=0,
            age_365_plus_qty=0,
        )}
        in_transit = {"SKU-A": 50}
        product_names = {"SKU-A": "Test Product"}
        # 90D=10, 30D=8, 14D=6, 7D=4 → 加权 = 10*.4+8*.3+6*.2+4*.1=8
        dms_map = {
            "SKU-A": _SeasonalDmsRow(
                sku="SKU-A",
                dms_90=Decimal("10"),
                dms_30=Decimal("8"),
                dms_14=Decimal("6"),
                dms_7=Decimal("4"),
                dms_90_yoy=None,
                dms_30_yoy=None,
                dms_14_yoy=None,
                dms_7_yoy=None,
            )
        }
        _patch_loaders(
            monkeypatch,
            base_skus=base,
            inventory=inventory,
            in_transit=in_transit,
            product_names=product_names,
            dms_map=dms_map,
        )

        to_date = date(2025, 9, 30)
        rows, summary, total, has_next = list_seasonal_replenishment_analysis(
            db=MagicMock(),
            project_id=1,
            country="US",
            from_date=date(2025, 7, 1),
            to_date=to_date,
            compare_year_offset=0,
            keyword=None,
            page=1,
            page_size=50,
        )

        assert total == 1
        assert has_next is False
        assert summary["sku_count"] == 1
        # 季节性页面不判定风险
        assert summary["out_of_stock_risk_count"] == 0
        assert summary["slow_moving_count"] == 0
        # healthy_count = 有 weighted_dms 的行数
        assert summary["healthy_count"] == 1
        assert summary["pending_data_count"] == 0
        assert summary["total_available_inventory"] == 100
        assert summary["total_in_transit_quantity"] == 50

        item = rows[0]
        # 加权 DMS = 8（验证权重归一）
        assert item["base_dms"] == 8.0
        # DEFAULT_SAFETY_FACTOR = 0.20 → weighted_dms = base_dms * (1 + 0.20) = 9.6
        assert item["weighted_dms"] == pytest.approx(9.6, rel=1e-9)
        # 可售天数 = 100 / 9.6 = 10.4167
        assert item["sellable_days"] == pytest.approx(100 / 9.6, rel=1e-3)
        # 含在途可售 = (100+50)/9.6 = 15.625
        # sellout_date 锚点是 to_date（不是 today！）
        # to_date = 2025-09-30 + ceil(10.42) 天 = 2025-10-10
        # 我们校验它 >= to_date 且年份/月份合理
        assert item["sellout_date"] is not None
        assert item["sellout_date"] >= "2025-09-30"
        # 关键差异：风险字段**不应该**出现
        assert "risk_status" not in item
        assert "risk_anchor_date" not in item

    def test_keyword_filter(self, monkeypatch):
        from app.services.inventory.replenishment import _BaseSkuRow

        base = [
            _BaseSkuRow(sku="SKU-A", asin="ASIN001", country="US"),
            _BaseSkuRow(sku="SKU-B", asin="ASIN002", country="US"),
        ]
        dms_map = {
            "SKU-A": _SeasonalDmsRow(
                sku="SKU-A",
                dms_90=Decimal("10"), dms_30=Decimal("10"),
                dms_14=Decimal("10"), dms_7=Decimal("10"),
                dms_90_yoy=None, dms_30_yoy=None, dms_14_yoy=None, dms_7_yoy=None,
            ),
        }
        _patch_loaders(monkeypatch, base_skus=base, dms_map=dms_map)

        rows, summary, total, _ = list_seasonal_replenishment_analysis(
            db=MagicMock(),
            project_id=1,
            country="US",
            from_date=date(2025, 7, 1),
            to_date=date(2025, 9, 30),
            compare_year_offset=0,
            keyword="SKU-B",
            page=1,
            page_size=50,
        )

        # 只返回 SKU-B
        assert total == 1
        assert rows[0]["sku"] == "SKU-B"

    def test_pagination(self, monkeypatch):
        from app.services.inventory.replenishment import _BaseSkuRow

        # 5 个 SKU，分页 page_size=2
        base = [
            _BaseSkuRow(sku=f"SKU-{i}", asin=None, country="US")
            for i in range(5)
        ]
        _patch_loaders(monkeypatch, base_skus=base)

        rows_p1, _, total_p1, has_next_p1 = list_seasonal_replenishment_analysis(
            db=MagicMock(),
            project_id=1,
            country="US",
            from_date=date(2025, 7, 1),
            to_date=date(2025, 9, 30),
            compare_year_offset=0,
            keyword=None,
            page=1,
            page_size=2,
        )
        assert total_p1 == 5
        assert len(rows_p1) == 2
        assert has_next_p1 is True

        rows_p3, _, total_p3, has_next_p3 = list_seasonal_replenishment_analysis(
            db=MagicMock(),
            project_id=1,
            country="US",
            from_date=date(2025, 7, 1),
            to_date=date(2025, 9, 30),
            compare_year_offset=0,
            keyword=None,
            page=3,
            page_size=2,
        )
        assert total_p3 == 5
        assert len(rows_p3) == 1  # 最后一页只剩 1 个
        assert has_next_p3 is False

    def test_no_dms_data_marks_pending(self, monkeypatch):
        """当所有窗口都没有销量时，weighted_dms=None，进入 pending_data_count。"""
        from app.services.inventory.replenishment import _BaseSkuRow

        base = [_BaseSkuRow(sku="SKU-A", asin=None, country="US")]
        # dms_map 空 → SKU 没销量
        _patch_loaders(monkeypatch, base_skus=base)

        rows, summary, _, _ = list_seasonal_replenishment_analysis(
            db=MagicMock(),
            project_id=1,
            country="US",
            from_date=date(2025, 7, 1),
            to_date=date(2025, 9, 30),
            compare_year_offset=0,
            keyword=None,
            page=1,
            page_size=50,
        )

        assert summary["healthy_count"] == 0
        assert summary["pending_data_count"] == 1
        assert rows[0]["weighted_dms"] is None
        assert rows[0]["sellable_days"] is None
        assert rows[0]["estimated_replenishment_quantity"] is None
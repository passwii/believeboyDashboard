"""Smoke tests for BEL-157 order_info service.

Covers pure logic paths (parse_date_input, fulfillment label mapping, serialization
shapes) without needing a live DB. Integration tests against the real DB live
in `tests/integration/` and run only in CI/dev envs.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from unittest.mock import MagicMock

import pytest

from app.schemas.order_info import OrderInfoItem
from app.services.data import order_info_service
from app.services.data.order_info_service import (
    DEFAULT_PAGE_SIZE,
    FULFILLMENT_LABEL_MAP,
    MAX_PAGE_SIZE,
    _extract_fulfillment_channel,
    _fulfillment_filter_sql_supported,
    _to_beijing_str,
    parse_date_input,
    serialize_order_row,
)

# ---------- parse_date_input ----------


class TestParseDateInput:
    def test_valid_yyyy_mm_dd(self):
        assert parse_date_input("2026-06-15") == date(2026, 6, 15)

    def test_none_returns_none(self):
        assert parse_date_input(None) is None

    def test_empty_string_returns_none(self):
        assert parse_date_input("") is None

    def test_garbage_returns_none(self):
        assert parse_date_input("not-a-date") is None

    def test_extra_characters_truncated(self):
        # "2026-06-15T10:00:00" → [:10] = "2026-06-15"
        assert parse_date_input("2026-06-15T10:00:00") == date(2026, 6, 15)


# ---------- Fulfillment label map ----------


class TestFulfillmentLabelMap:
    def test_amazon_maps_to_fba(self):
        assert FULFILLMENT_LABEL_MAP["Amazon"] == "FBA（亚马逊配送）"

    def test_merchant_maps_to_fbm(self):
        assert FULFILLMENT_LABEL_MAP["Merchant"] == "FBM（自发货配送）"


# ---------- _to_beijing_str ----------


class TestToBeijingStr:
    def test_utc_input_converts_to_beijing(self):
        # 2026-06-17 01:40:20 UTC → 2026-06-17 09:40:20 Beijing
        utc = datetime(2026, 6, 17, 1, 40, 20, tzinfo=timezone.utc)
        assert _to_beijing_str(utc) == "2026-06-17 09:40:20"

    def test_naive_input_treated_as_utc(self):
        # naive datetime → assumed UTC, then converted to Beijing (+8h)
        naive = datetime(2026, 6, 17, 1, 40, 20)
        assert _to_beijing_str(naive) == "2026-06-17 09:40:20"

    def test_non_datetime_returns_empty(self):
        assert _to_beijing_str(None) == ""
        assert _to_beijing_str("2026-06-17") == ""


# ---------- _extract_fulfillment_channel ----------


class TestExtractFulfillmentChannel:
    def test_returns_amazon_when_present(self):
        row = MagicMock()
        row.raw_row = {"fulfillment-channel": "Amazon"}
        assert _extract_fulfillment_channel(row) == "Amazon"

    def test_returns_merchant_when_present(self):
        row = MagicMock()
        row.raw_row = {"fulfillment-channel": "Merchant"}
        assert _extract_fulfillment_channel(row) == "Merchant"

    def test_returns_empty_when_missing(self):
        row = MagicMock()
        row.raw_row = {}
        assert _extract_fulfillment_channel(row) == ""

    def test_returns_empty_for_none_raw_row(self):
        row = MagicMock()
        row.raw_row = None
        assert _extract_fulfillment_channel(row) == ""


# ---------- _fulfillment_filter_sql_supported ----------


class TestFulfillmentFilterSqlSupported:
    def test_postgresql_dialect_supported(self):
        db = MagicMock()
        db.bind.dialect.name = "postgresql"
        assert _fulfillment_filter_sql_supported(db) is True

    def test_postgres_alias_supported(self):
        db = MagicMock()
        db.bind.dialect.name = "postgres"
        assert _fulfillment_filter_sql_supported(db) is True

    def test_sqlite_not_supported(self):
        db = MagicMock()
        db.bind.dialect.name = "sqlite"
        assert _fulfillment_filter_sql_supported(db) is False

    def test_no_bind_returns_false(self):
        db = MagicMock()
        db.bind = None
        assert _fulfillment_filter_sql_supported(db) is False


# ---------- serialize_order_row ----------


class TestSerializeOrderRow:
    def test_minimal_row(self):
        row = MagicMock()
        row.id = 1
        row.source_file_id = 10
        row.purchase_at_utc = datetime(2026, 6, 17, 1, 40, 20, tzinfo=timezone.utc)
        row.purchase_at_pt = datetime(2026, 6, 16, 18, 40, 20)
        row.purchase_date_pt = date(2026, 6, 16)
        row.amazon_order_id = "111-2222222-3333333"
        row.order_status = "Shipped"
        row.sku = "TEST-SKU-001"
        row.asin = "B0TESTTEST"
        row.quantity = 2
        row.item_price = 19.99
        row.shipping_price = 0.0
        row.currency = "USD"
        row.country = "US"
        row.is_counted_sales = True
        row.created_at = datetime(2026, 6, 17, 2, 0, 0, tzinfo=timezone.utc)
        row.raw_row = {
            "fulfillment-channel": "Amazon",
            "ship-service-level": "Expedited",
            "product-name": "Test Product",
            "ship-state": "CA",
            "ship-city": "San Francisco",
            "ship-postal-code": "94105",
        }
        project = MagicMock()
        project.id = 15
        project.project_name = "测试项目"
        project.brand_name = "TestBrand"

        # 2026-06-27 迁移 200 新增字段：mock 默认会返回 MagicMock 字符串，显式置 None
        row.carrier = None
        row.tracking_no = None
        row.shipped_at = None
        row.updated_by = None
        row.updated_at = None

        item = serialize_order_row(row, project=project)

        assert isinstance(item, OrderInfoItem)
        assert item.id == 1
        assert item.project_id == 15
        assert item.project_name == "测试项目"
        assert item.carrier is None
        assert item.tracking_no is None
        assert item.shipped_at is None
        assert item.updated_by is None
        assert item.updated_at is None
        assert item.brand_name == "TestBrand"
        assert item.amazon_order_id == "111-2222222-3333333"
        assert item.sku == "TEST-SKU-001"
        assert item.asin == "B0TESTTEST"
        assert item.quantity == 2
        assert item.item_price == 19.99
        assert item.shipping_price == 0.0
        assert item.currency == "USD"
        assert item.country == "US"
        assert item.state == "CA"
        assert item.city == "San Francisco"
        assert item.postal_code == "94105"
        assert item.fulfillment_channel == "Amazon"
        assert item.fulfillment_label == "FBA（亚马逊配送）"
        assert item.ship_service_level == "Expedited"
        assert item.product_name == "Test Product"

    def test_unknown_fulfillment_falls_back_to_raw_value(self):
        row = MagicMock()
        row.id = 1
        row.source_file_id = 10
        row.purchase_at_utc = datetime(2026, 6, 17, 1, 40, 20, tzinfo=timezone.utc)
        row.purchase_at_pt = datetime(2026, 6, 16, 18, 40, 20)
        row.purchase_date_pt = date(2026, 6, 16)
        row.amazon_order_id = "X"
        row.order_status = "Shipped"
        row.sku = None
        row.asin = None
        row.quantity = 0
        row.item_price = 0
        row.shipping_price = 0
        row.currency = None
        row.country = "US"
        row.is_counted_sales = False
        row.created_at = datetime(2026, 6, 17, 2, 0, 0, tzinfo=timezone.utc)
        row.raw_row = {"fulfillment-channel": "SOMETHING_NEW"}
        project = MagicMock()
        project.id = 1
        project.project_name = "P"
        project.brand_name = None

        row.carrier = None
        row.tracking_no = None
        row.shipped_at = None
        row.updated_by = None
        row.updated_at = None

        item = serialize_order_row(row, project=project)

        assert item.fulfillment_channel == "SOMETHING_NEW"
        assert item.fulfillment_label == "SOMETHING_NEW"

    def test_no_project_returns_sentinel(self):
        row = MagicMock()
        row.id = 1
        row.source_file_id = 10
        row.purchase_at_utc = datetime(2026, 6, 17, 1, 40, 20, tzinfo=timezone.utc)
        row.purchase_at_pt = datetime(2026, 6, 16, 18, 40, 20)
        row.purchase_date_pt = date(2026, 6, 16)
        row.amazon_order_id = "X"
        row.order_status = "Unknown"
        row.sku = None
        row.asin = None
        row.quantity = 0
        row.item_price = 0
        row.shipping_price = 0
        row.currency = None
        row.country = "US"
        row.is_counted_sales = False
        row.created_at = datetime(2026, 6, 17, 2, 0, 0, tzinfo=timezone.utc)
        row.raw_row = {}

        row.carrier = None
        row.tracking_no = None
        row.shipped_at = None
        row.updated_by = None
        row.updated_at = None

        item = serialize_order_row(row, project=None)

        assert item.project_id == -1
        assert item.project_name == "未知项目"
        assert item.brand_name is None


# ---------- Constants ----------


class TestConstants:
    def test_default_page_size_sane(self):
        assert 1 <= DEFAULT_PAGE_SIZE <= MAX_PAGE_SIZE

    def test_max_page_size_sane(self):
        assert MAX_PAGE_SIZE <= 1000


# ---------- is_current 过滤 ----------


class TestCurrentFilter:
    """验证 _build_base_query / list_orders 的 count_sql 都强制走
    AnalysisSourceFile.is_current = TRUE。
    """

    def test_base_query_includes_is_current(self):
        from sqlalchemy.dialects import sqlite

        stmt = order_info_service._build_base_query()
        compiled = str(
            stmt.compile(
                dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}
            )
        )
        # is_current 过滤必须出现在 SQL 文本里
        assert "is_current" in compiled
        # 同时 boolean 表达式 true（或 1）也应存在
        assert (
            ("true" in compiled) or ("1" in compiled) or ("IS TRUE" in compiled.upper())
        )

    def test_list_orders_count_sql_includes_is_current(self, monkeypatch):
        """通过 stub db 验证 list_orders 的 count_sql 路径也带 is_current。"""
        from app.services.data import order_info_service as svc

        captured: dict[str, object] = {}

        class _FakeResult:
            def scalar(self):
                return 0

            def all(self):
                return []

        class _FakeDB:
            def execute(self, stmt):
                from sqlalchemy.dialects import sqlite

                compiled = str(
                    stmt.compile(
                        dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}
                    )
                )
                # 只关心第一次调用（count_sql），记下文本即可
                if "count(" in compiled and "count_sql" not in captured:
                    captured["count_sql"] = compiled
                return _FakeResult()

        db = _FakeDB()
        result = svc.list_orders(
            db,
            project_ids=None,
            operator="someone",
            is_admin=True,
        )
        assert "is_current" in captured.get("count_sql", "")


# ---------- operator / is_admin 行为 ----------


class TestOperatorAccess:
    """非 admin 操作员的项目范围缩窄：admin 透传、非 admin 按 _ensure_project_access 过滤。"""

    def test_admin_returns_candidate_unchanged(self):
        from app.services.data import order_info_service as svc

        db = MagicMock()
        result = svc._ensure_project_access_for_orders(
            db, candidate_project_ids=[1, 2, 3], operator="op1", is_admin=True
        )
        assert result == [1, 2, 3]

    def test_admin_with_empty_candidate_returns_none_for_unrestricted(self):
        """admin + 没传 project_ids（前端默认「全部店铺」）→ 返回 None，让 caller
        的 SQL 不带 project_id 过滤，而不是被「空列表 → 0 行」早返回误伤。
        """
        from app.services.data import order_info_service as svc

        db = MagicMock()
        result = svc._ensure_project_access_for_orders(
            db, candidate_project_ids=[], operator="admin_user", is_admin=True
        )
        assert result is None

    def test_admin_with_none_candidate_returns_none_for_unrestricted(self):
        """admin + candidate_project_ids=None 也应返回 None（不限）。"""
        from app.services.data import order_info_service as svc

        db = MagicMock()
        result = svc._ensure_project_access_for_orders(
            db, candidate_project_ids=None, operator="admin_user", is_admin=True
        )
        assert result is None

    def test_non_admin_without_operator_returns_empty(self):
        from app.services.data import order_info_service as svc

        db = MagicMock()
        result = svc._ensure_project_access_for_orders(
            db, candidate_project_ids=[1, 2], operator=None, is_admin=False
        )
        assert result == []

    def test_non_admin_with_candidate_filters_via_ensure_access(self, monkeypatch):
        """非 admin + 传了 candidate_project_ids 时，调用 _ensure_project_access 过滤；
        抛 403 的项目会被剔除。
        """
        from app.services.data import order_info_service as svc

        seen: list[int] = []

        def fake_ensure(db, *, project_id, operator, is_admin):
            seen.append(int(project_id))
            if project_id == 2:
                # 模拟无权限
                from fastapi import HTTPException

                raise HTTPException(status_code=403, detail="no access")
            return MagicMock()

        monkeypatch.setattr(
            svc,
            "_ensure_project_access_for_orders",
            svc._ensure_project_access_for_orders,
        )
        monkeypatch.setattr(
            "app.services.ad.helpers._ensure_project_access", fake_ensure
        )

        db = MagicMock()
        result = svc._ensure_project_access_for_orders(
            db, candidate_project_ids=[1, 2, 3], operator="op1", is_admin=False
        )
        # project 2 被拒，应只留 [1, 3]
        assert result == [1, 3]
        assert seen == [1, 2, 3]


# ---------- update_order_by_id (FBM 补录) ----------


class TestUpdateOrderById:
    """FBM 补录逻辑。Mock DB.execute.first() 返回 (row, project)，验证：写入列、权限、updated_at 兜底。"""

    def _make_row(self):
        row = MagicMock()
        row.id = 100
        row.source_file_id = 10
        row.carrier = None
        row.tracking_no = None
        row.shipped_at = None
        row.updated_by = None
        row.updated_at = None
        row.purchase_at_utc = datetime(2026, 6, 17, 1, 40, 20, tzinfo=timezone.utc)
        row.purchase_at_pt = datetime(2026, 6, 16, 18, 40, 20)
        row.purchase_date_pt = date(2026, 6, 16)
        row.amazon_order_id = "111-FBM-001"
        row.order_status = "Pending"
        row.sku = "SKU-FBM"
        row.asin = "B0FBM0001"
        row.quantity = 1
        row.item_price = 9.99
        row.shipping_price = 0.0
        row.currency = "USD"
        row.country = "US"
        row.is_counted_sales = False
        row.created_at = datetime(2026, 6, 17, 2, 0, 0, tzinfo=timezone.utc)
        row.raw_row = {"fulfillment-channel": "Merchant"}
        return row

    def _make_project(self, pid=15):
        project = MagicMock()
        project.id = pid
        project.project_name = "FBM 测试店铺"
        project.brand_name = "FB"
        return project

    def _make_db(self, row, project):
        class _Result:
            def first(inner_self):
                return (row, project) if row else None

        return _Result()

    def _make_db_full(self, row, project):
        """完整 mock db：execute().first() + flush()"""

        class _R:
            def first(inner_self_):
                return (row, project)

        class _DB:
            def execute(inner_self, stmt):
                return _R()

            def flush(inner_self):
                return None

        return _DB()

    def test_admin_can_update_carrier_and_tracking(self, monkeypatch):
        from app.schemas.order_info import OrderInfoUpdate
        from app.services.data import order_info_service as svc

        row = self._make_row()
        project = self._make_project()

        # 模拟 db.execute(stmt).first() → (row, project)
        db = self._make_db_full(row, project)
        payload = OrderInfoUpdate(carrier="UPS", tracking_no="1Z999AA10123456784")
        updated = svc.update_order_by_id(
            db, 100, payload, operator="admin_user", is_admin=True
        )

        assert row.carrier == "UPS"
        assert row.tracking_no == "1Z999AA10123456784"
        assert row.shipped_at is None  # 未传
        assert row.updated_by is None  # 未传
        assert row.updated_at is not None  # 兜底填
        assert updated.carrier == "UPS"
        assert updated.tracking_no == "1Z999AA10123456784"
        assert updated.fulfillment_channel == "Merchant"

    def test_admin_can_set_shipped_at(self, monkeypatch):
        from app.schemas.order_info import OrderInfoUpdate
        from app.services.data import order_info_service as svc

        row = self._make_row()
        project = self._make_project()
        shipped = datetime(2026, 6, 18, 9, 0, 0, tzinfo=timezone.utc)

        db = self._make_db_full(row, project)
        payload = OrderInfoUpdate(shipped_at=shipped, updated_by="operator_zhang")
        updated = svc.update_order_by_id(
            db, 100, payload, operator="admin_user", is_admin=True
        )

        assert row.shipped_at == shipped
        assert row.updated_by == "operator_zhang"
        assert updated.shipped_at == shipped

    def test_operator_without_access_raises_forbidden(self, monkeypatch):
        """operator 编辑无访问权的店铺订单 → OrderInfoForbidden"""
        from app.schemas.order_info import OrderInfoUpdate
        from app.services.data import order_info_service as svc

        row = self._make_row()
        project = self._make_project()

        db = self._make_db_full(row, project)

        # 强制 _ensure_project_access_for_orders 返回 []（模拟 operator 无权）
        monkeypatch.setattr(
            svc,
            "_ensure_project_access_for_orders",
            lambda db, *, candidate_project_ids, operator, is_admin: [],
        )

        payload = OrderInfoUpdate(carrier="USPS")
        with pytest.raises(svc.OrderInfoForbidden):
            svc.update_order_by_id(db, 100, payload, operator="op1", is_admin=False)

    def test_not_found_raises_order_info_not_found(self, monkeypatch):
        from app.schemas.order_info import OrderInfoUpdate
        from app.services.data import order_info_service as svc

        class _DB:
            def execute(inner_self, stmt):
                class _R:
                    def first(inner_self_):
                        return None

                return _R()

        payload = OrderInfoUpdate(carrier="DHL")
        with pytest.raises(svc.OrderInfoNotFound):
            svc.update_order_by_id(
                _DB(), 9999, payload, operator="admin_user", is_admin=True
            )

    def test_updated_by_falls_back_to_operator_when_empty(self, monkeypatch):
        """payload.updated_by 显式为空串 → 清空；不传则由 endpoint 兜底填 operator（service 不动）"""
        from app.schemas.order_info import OrderInfoUpdate
        from app.services.data import order_info_service as svc

        row = self._make_row()
        project = self._make_project()

        db = self._make_db_full(row, project)

        # 显式传空串 → 清空
        payload = OrderInfoUpdate(updated_by="")
        svc.update_order_by_id(db, 100, payload, operator="admin_user", is_admin=True)
        assert row.updated_by is None

    def test_carrier_whitespace_normalized_to_none(self, monkeypatch):
        """纯空白 carrier 应当被 _safe_str 归一化为 None"""
        from app.schemas.order_info import OrderInfoUpdate
        from app.services.data import order_info_service as svc

        row = self._make_row()
        project = self._make_project()

        db = self._make_db_full(row, project)
        payload = OrderInfoUpdate(carrier="   ", tracking_no="  ABC123  ")
        updated = svc.update_order_by_id(
            db, 100, payload, operator="admin_user", is_admin=True
        )
        assert row.carrier is None  # 空白被 trim 后视为 None
        assert row.tracking_no == "ABC123"
        assert updated.carrier is None
        assert updated.tracking_no == "ABC123"


# ---------- CSV headers 含新列 ----------


class TestOrderCsvHeaders:
    def test_csv_headers_include_carrier_tracking(self):
        from app.services.data.order_info_service import ORDER_CSV_HEADERS

        assert "物流商" in ORDER_CSV_HEADERS
        assert "物流单号" in ORDER_CSV_HEADERS
        assert "发货时间" in ORDER_CSV_HEADERS
        assert "更新人" in ORDER_CSV_HEADERS
        assert "更新时间" in ORDER_CSV_HEADERS


class TestCollectFilterOptionsProjects:
    """collect_filter_options 的项目下拉应该与全站其他页面（daily-analysis /
    shipment-management / sku-info / auto-upload / ai-insights / report-upload）
    共用 `project_service.list_project_items` 的顺序——即 `sort_order.asc(), id.asc()`，
    而不是 `project_name.asc()`。否则两边下拉顺序不一致，用户体验割裂。
    """

    def _fake_project(self, pid, name, brand=None, sort_order=0):
        row = MagicMock()
        row.id = pid
        row.project_name = name
        row.brand_name = brand
        row.sort_order = sort_order
        return row

    def test_collect_filter_options_delegates_to_list_project_items(self, monkeypatch):
        """admin + 任意 operator：项目下拉必须按 list_project_items 的返回顺序（已含
        sort_order.asc() 排序），而不是按 project_name 字母序。
        """
        # list_project_items 已经按 sort_order.asc() 排好的顺序
        rows = [
            self._fake_project(3, "Charlie", sort_order=10),
            self._fake_project(1, "Alpha", brand="A牌", sort_order=20),
            self._fake_project(2, "Bravo", sort_order=30),
        ]
        captured_kwargs: dict = {}

        def fake_list_project_items(db, **kwargs):
            captured_kwargs.update(kwargs)
            return rows

        # collect_filter_options 通过 `from app.services import project_service` 后
        # 调用 project_service.list_project_items；monkeypatch 打在原模块上即可。
        monkeypatch.setattr(
            "app.services.project_service.list_project_items", fake_list_project_items
        )

        result = order_info_service.collect_filter_options(
            MagicMock(), operator="op1", is_admin=True
        )

        # 顺序与 list_project_items 返回一致（Charlie / Alpha / Bravo），而不是
        # 按字母序的 Alpha / Bravo / Charlie
        assert [opt.value for opt in result.projects] == ["3", "1", "2"]
        assert [opt.label for opt in result.projects] == [
            "Charlie",
            "Alpha（A牌）",
            "Bravo",
        ]
        # include_inactive 必须 False（筛选项只显示激活店铺）
        assert captured_kwargs.get("include_inactive") is False

    def test_collect_filter_options_passes_operator_for_non_admin_scope(
        self, monkeypatch
    ):
        """非 admin 必须把 operator 透传给 list_project_items，让它做权限过滤。"""
        captured_kwargs: dict = {}

        def fake_list_project_items(db, **kwargs):
            captured_kwargs.update(kwargs)
            return []

        monkeypatch.setattr(
            "app.services.project_service.list_project_items", fake_list_project_items
        )

        order_info_service.collect_filter_options(
            MagicMock(), operator="张三", is_admin=False
        )

        assert captured_kwargs.get("operator") == "张三"
        assert captured_kwargs.get("is_admin") is False

    def test_collect_filter_options_dedupes_repeated_ids(self, monkeypatch):
        """list_project_items 理论上不会重复，但前端拼成 FilterOption 时要兜底去重。"""
        rows = [
            self._fake_project(7, "Same", sort_order=1),
            self._fake_project(7, "Same-dup", sort_order=2),
        ]
        monkeypatch.setattr(
            "app.services.project_service.list_project_items",
            lambda db, **kw: rows,
        )

        result = order_info_service.collect_filter_options(
            MagicMock(), operator="op", is_admin=True
        )
        assert [opt.value for opt in result.projects] == ["7"]


# ---- compute_stats tests below ----
#
# Background: `compute_stats` was the prime suspect for /dashboard/supply-chain/order-info
# intermittent timeouts — every filter change pulled up to 10,000 rows + Python-loop
# aggregates. After the fix it should run a pure SQL aggregate (1 row) plus a
# GROUP BY currency query (1 row), and apply the fulfillment-channel filter in SQL
# (via raw_row JSON path → `JSON_EXTRACT` on SQLite / `->>` on PG).
#
# We assert against the COMPILED SQL — not the result values — to lock in the
# "no row pull" behavior so a future refactor that re-introduces `LIMIT 10000`
# trips these tests.

from sqlalchemy.dialects import sqlite as sqlite_dialect


def _compile(stmt):
    return str(
        stmt.compile(
            dialect=sqlite_dialect.dialect(), compile_kwargs={"literal_binds": True}
        )
    )


class TestComputeStatsSqlAggregate:
    """compute_stats must be O(1) result rows: one aggregate + one currency-mode query.

    These tests stub the DB to capture the SQL emitted. They do NOT need live data
    — the goal is to lock in that we do not pull the underlying rows.
    """

    def test_aggregate_query_uses_count_and_sum_not_limit(self, monkeypatch):
        """Main aggregate SELECT must contain COUNT/SUM/case-when, must NOT contain
        `LIMIT` (no row pull)."""
        from app.services.data import order_info_service as svc

        captured: dict[str, str] = {}

        class _AggRow:
            total_orders = 42
            total_quantity = 100
            total_amount = 1234.56
            fba_count = 25
            fbm_count = 17

        class _FakeResult:
            def one(inner_self):
                return _AggRow()

            def all(inner_self):
                return []  # currency-mode returns empty → dominant_currency = None

        class _FakeDB:
            def execute(inner_self, stmt):
                sql = _compile(stmt)
                if (
                    "count(" in sql.lower()
                    and "sum(" in sql.lower()
                    and "aggregate" not in captured
                ):
                    captured["aggregate"] = sql
                return _FakeResult()

        db = _FakeDB()
        result = svc.compute_stats(
            db,
            project_ids=None,
            order_statuses=None,
            countries=None,
            currencies=None,
            operator="admin_user",
            is_admin=True,
        )
        assert "limit" not in captured["aggregate"].lower(), (
            f"compute_stats main aggregate must not LIMIT; got:\n{captured['aggregate']}"
        )
        assert "case" in captured["aggregate"].lower(), (
            f"compute_stats must use CASE WHEN for FBA/FBM counts; got:\n{captured['aggregate']}"
        )
        assert result.total_orders == 42
        assert result.total_quantity == 100
        assert result.total_amount == 1234.56
        assert result.fba_count == 25
        assert result.fbm_count == 17
        assert result.currency is None

    def test_fulfillment_channel_filter_applied_in_sql(self, monkeypatch):
        """When fulfillment_channels is provided, the SQL emitted must contain
        the fulfillment-channel filter."""
        from app.services.data import order_info_service as svc

        captured: list[str] = []

        class _AggRow:
            total_orders = 5
            total_quantity = 5
            total_amount = 50.0
            fba_count = 5
            fbm_count = 0

        class _FakeResult:
            def one(inner_self):
                return _AggRow()

            def all(inner_self):
                return []

        class _FakeDB:
            def execute(inner_self, stmt):
                captured.append(_compile(stmt))
                return _FakeResult()

        db = _FakeDB()
        svc.compute_stats(
            db,
            fulfillment_channels=["Amazon"],
            operator="admin_user",
            is_admin=True,
        )
        aggregate_sql = captured[0].lower()
        assert "fulfillment-channel" in aggregate_sql, (
            f"fc filter must be applied in SQL; got:\n{captured[0]}"
        )

    def test_fulfillment_filter_works_on_sqlite_via_json_extract(self):
        """The compiled SQL on SQLite must use JSON_EXTRACT(...) so it works
        without depending on the dialect-detection gating (JSON1 is built into
        stdlib sqlite3 3.9+)."""
        from app.models.product_analysis_source import AnalysisSalesOrderRow
        from app.services.data import order_info_service as svc

        fc_expr = AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string()
        stmt = svc._build_base_query().where(fc_expr == "Amazon")
        compiled = _compile(stmt).lower()
        assert "json_extract" in compiled or "->>" in compiled, (
            f"fc filter must compile to JSON_EXTRACT (sqlite) or ->> (pg); got:\n{compiled}"
        )

    def test_dominant_currency_uses_group_by_order_by_limit(self, monkeypatch):
        """The currency-mode query must GROUP BY currency + ORDER BY count DESC + LIMIT 1."""
        from app.services.data import order_info_service as svc

        # Phase 0 = aggregate, 1+ = currency-mode (and any later queries).
        captured: list[str] = []
        call_count = 0

        class _AggRow:
            total_orders = 10
            total_quantity = 10
            total_amount = 100.0
            fba_count = 6
            fbm_count = 4

        class _CurrencyRow:
            currency = "USD"
            c = 8

        class _FakeResult:
            def one(inner_self):
                return _AggRow()

            def all(inner_self):
                return [_CurrencyRow()]

        class _FakeDB:
            def execute(inner_self, stmt):
                nonlocal call_count
                call_count += 1
                captured.append(_compile(stmt))
                return _FakeResult()

        db = _FakeDB()
        result = svc.compute_stats(
            db,
            operator="admin_user",
            is_admin=True,
        )
        assert len(captured) >= 2, (
            f"expected aggregate + currency-mode, got: {captured}"
        )
        currency_query = captured[-1].lower()
        assert "group by" in currency_query
        assert "order by" in currency_query
        assert "limit" in currency_query
        assert "currency" in currency_query
        assert result.currency == "USD"

    def test_no_access_returns_zeros_without_running_query(self, monkeypatch):
        """Non-admin with no accessible projects must short-circuit to zeros
        WITHOUT issuing any SQL aggregate — same behavior as before."""
        from app.services.data import order_info_service as svc

        executed: list[str] = []

        class _FakeResult:
            def one(inner_self):
                return None

            def all(inner_self):
                return []

        class _FakeDB:
            def execute(inner_self, stmt):
                executed.append(_compile(stmt))
                return _FakeResult()

        db = _FakeDB()
        monkeypatch.setattr(
            svc, "_ensure_project_access_for_orders", lambda *a, **kw: []
        )

        result = svc.compute_stats(
            db,
            project_ids=[1, 2, 3],
            operator="some_op",
            is_admin=False,
        )
        assert result.total_orders == 0
        assert result.total_quantity == 0
        assert result.total_amount == 0.0
        assert result.fba_count == 0
        assert result.fbm_count == 0
        assert result.currency is None
        assert executed == [], f"expected no DB calls, got: {executed}"


# ---------- get_overview / list_orders known_total（order-info 性能优化 C）----------
#
# 背景：order-info 页面原先每次筛选并行发 /list + /stats 两请求，后端在两个独立
# 会话里对大表重复全扫描（4 次），是 CPU/内存飙升根因之一。优化后：
#   - get_overview 单请求单事务返回 列表 + 统计；
#   - compute_stats 主聚合里的 total_orders 与 list 精确 count 等价，复用为
#     known_total 让 list_orders 跳过 count 全扫描（4 → 3 次）。
# 这些测试锁定：known_total 确实省掉 count 查询，且 get_overview 只在「无 fc 过滤」
# 或「SQL 可精确过滤 fc」时共享 total（SQLite+fc 的应用层 fallback 路径不共享）。


class TestListOrdersKnownTotal:
    """list_orders 传入 known_total 时应跳过 count 全扫描，直接用该 total。"""

    def test_known_total_skips_count_query(self):
        from app.services.data import order_info_service as svc

        executed: list[str] = []

        class _FakeResult:
            def scalar(inner_self):
                return 0

            def all(inner_self):
                return []  # 分页行：空

        class _FakeDB:
            def execute(inner_self, stmt):
                executed.append(_compile(stmt))
                return _FakeResult()

        db = _FakeDB()
        result = svc.list_orders(
            db,
            project_ids=None,
            operator="admin_user",
            is_admin=True,
            known_total=99,
        )
        # total 直接取 known_total，且没有执行任何 count( 查询
        assert result.total == 99
        assert result.items == []
        count_queries = [sql for sql in executed if "count(" in sql.lower()]
        assert count_queries == [], (
            f"known_total 必须跳过 count 全扫描，却执行了: {count_queries}"
        )
        # 但仍要执行分页查询（带 LIMIT）
        assert any("limit" in sql.lower() for sql in executed), (
            f"known_total 路径仍需执行分页查询; got: {executed}"
        )

    def test_known_total_applies_fc_filter_in_sql(self):
        from app.services.data import order_info_service as svc

        executed: list[str] = []

        class _FakeResult:
            def scalar(inner_self):
                return 0

            def all(inner_self):
                return []

        class _FakeDB:
            def execute(inner_self, stmt):
                executed.append(_compile(stmt))
                return _FakeResult()

        db = _FakeDB()
        svc.list_orders(
            db,
            fulfillment_channels=["Amazon"],
            operator="admin_user",
            is_admin=True,
            known_total=5,
        )
        # known_total 路径走纯 SQL，fulfillment-channel 过滤必须出现在分页查询里
        assert any("fulfillment-channel" in sql for sql in executed), (
            f"known_total 路径 fc 过滤须在 SQL; got: {executed}"
        )

    def test_known_total_none_still_runs_count(self):
        """回归：不传 known_total（所有既有调用方）时 count 查询照常执行。"""
        from app.services.data import order_info_service as svc

        executed: list[str] = []

        class _FakeResult:
            def scalar(inner_self):
                return 0

            def all(inner_self):
                return []

        class _FakeDB:
            def execute(inner_self, stmt):
                executed.append(_compile(stmt))
                return _FakeResult()

        db = _FakeDB()
        svc.list_orders(db, project_ids=None, operator="admin_user", is_admin=True)
        assert any("count(" in sql.lower() for sql in executed), (
            f"默认路径必须执行 count 查询; got: {executed}"
        )


class TestGetOverview:
    """get_overview 编排：单请求出 列表+统计，并按 dialect/fc 决定是否共享 total。"""

    @staticmethod
    def _patch(svc, monkeypatch, *, sql_supported: bool, listing_total: int = 42):
        """替换 compute_stats / list_orders / _fulfillment_filter_sql_supported，
        返回捕获 list_orders kwargs 的字典。"""
        from app.schemas.order_info import OrderInfoListResponse, OrderInfoStats

        captured: dict[str, object] = {}

        def fake_compute_stats(db, **kwargs):
            return OrderInfoStats(
                total_orders=listing_total,
                total_quantity=100,
                total_amount=1234.56,
                currency="USD",
                fba_count=25,
                fbm_count=17,
            )

        def fake_list_orders(db, **kwargs):
            captured.update(kwargs)
            return OrderInfoListResponse(
                items=[],
                total=kwargs.get("known_total") or listing_total,
                page=kwargs.get("page", 1),
                page_size=kwargs.get("page_size", 50),
            )

        monkeypatch.setattr(svc, "compute_stats", fake_compute_stats)
        monkeypatch.setattr(svc, "list_orders", fake_list_orders)
        monkeypatch.setattr(
            svc, "_fulfillment_filter_sql_supported", lambda db: sql_supported
        )
        return captured

    def test_no_fc_shares_total(self, monkeypatch):
        from app.services.data import order_info_service as svc

        captured = self._patch(svc, monkeypatch, sql_supported=False, listing_total=42)
        result = svc.get_overview(db=object(), operator="admin_user", is_admin=True)
        # 无 fc 过滤 → 共享 compute_stats 的 total_orders，省掉 count 全扫描
        assert captured["known_total"] == 42
        assert result.total == 42
        assert result.stats.total_orders == 42
        assert result.stats.total_amount == 1234.56

    def test_fc_sql_supported_shares_total(self, monkeypatch):
        from app.services.data import order_info_service as svc

        captured = self._patch(svc, monkeypatch, sql_supported=True, listing_total=7)
        svc.get_overview(
            db=object(),
            fulfillment_channels=["Amazon"],
            operator="admin_user",
            is_admin=True,
        )
        # PG 生产：fc 可 SQL 精确过滤 → 共享 total
        assert captured["known_total"] == 7

    def test_fc_sql_unsupported_does_not_share_total(self, monkeypatch):
        from app.services.data import order_info_service as svc

        captured = self._patch(svc, monkeypatch, sql_supported=False, listing_total=7)
        svc.get_overview(
            db=object(),
            fulfillment_channels=["Amazon"],
            operator="admin_user",
            is_admin=True,
        )
        # SQLite + fc 走应用层 fallback，total 由 list_orders 自算 → 不共享
        assert captured["known_total"] is None

    def test_assembles_overview_response(self, monkeypatch):
        from app.schemas.order_info import OrderInfoOverview
        from app.services.data import order_info_service as svc

        self._patch(svc, monkeypatch, sql_supported=True, listing_total=7)
        result = svc.get_overview(
            db=object(),
            page=2,
            page_size=25,
            operator="admin_user",
            is_admin=True,
        )
        assert isinstance(result, OrderInfoOverview)
        assert result.items == []
        assert result.page == 2
        assert result.page_size == 25
        assert result.stats.currency == "USD"
        assert result.stats.fba_count == 25
        assert result.stats.fbm_count == 17

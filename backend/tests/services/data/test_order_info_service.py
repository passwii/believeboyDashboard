"""Smoke tests for BEL-157 order_info service.

Covers pure logic paths (parse_date_input, fulfillment label mapping, serialization
shapes) without needing a live DB. Integration tests against the real DB live
in `tests/integration/` and run only in CI/dev envs.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from unittest.mock import MagicMock

import pytest

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
from app.schemas.order_info import OrderInfoItem


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
        compiled = str(stmt.compile(dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}))
        # is_current 过滤必须出现在 SQL 文本里
        assert "is_current" in compiled
        # 同时 boolean 表达式 true（或 1）也应存在
        assert ("true" in compiled) or ("1" in compiled) or ("IS TRUE" in compiled.upper())

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

                compiled = str(stmt.compile(dialect=sqlite.dialect(), compile_kwargs={"literal_binds": True}))
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

        monkeypatch.setattr(svc, "_ensure_project_access_for_orders", svc._ensure_project_access_for_orders)
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
            svc.update_order_by_id(
                db, 100, payload, operator="op1", is_admin=False
            )

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
        svc.update_order_by_id(
            db, 100, payload, operator="admin_user", is_admin=True
        )
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

    def test_collect_filter_options_passes_operator_for_non_admin_scope(self, monkeypatch):
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
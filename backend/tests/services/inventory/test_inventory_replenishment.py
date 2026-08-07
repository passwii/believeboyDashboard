from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, PropertyMock

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import (
    AnalysisBusinessRow,
    AnalysisSourceFile,
    InventoryReplenishmentSetting,
    InventorySnapshotRow,
    SkuRecord,
    Project,
    ShipmentSchedule,
    ShipmentScheduleItem,
)
from app.services.inventory.replenishment import (
    IN_TRANSIT_STATUSES,
    RISK_HEALTHY,
    RISK_LONG_TERM_OUT_OF_STOCK,
    RISK_OUT_OF_STOCK,
    RISK_PENDING,
    RISK_SEVERE_SLOW_MOVING,
    RISK_SHORT_TERM_OUT_OF_STOCK,
    RISK_SLOW_MOVING,
    _BaseSkuRow,
    _add_days,
    _classify_risk,
    _get_project_or_404,
    _load_asin_to_skus_map,
    _load_base_skus,
    _load_business_dms_map,
    _load_in_transit_map,
    _load_inventory_map,
    _load_recent_sales_dms_map,
    _load_sales_dms_map,
    _load_settings_map,
    _normalize_weighted_dms,
    _pick_business_source,
    _subtract_days,
    list_inventory_replenishment_analysis,
    list_inventory_replenishment_shipments,
    list_snapshot_options,
    upsert_inventory_replenishment_setting,
)
from app.utils.constants import (
    DEFAULT_PRODUCTION_LEAD_DAYS,
    DEFAULT_SAFETY_FACTOR,
    DEFAULT_SHIPPING_DAYS,
    RECENT_SALES_LAG_DAYS,
    RECENT_SALES_WINDOW_DAYS,
)


@pytest.fixture
def db_session():
    """本文件全是纯单元测试，完全 mock 掉 DB 会话（无真实 I/O）。

    在模块内遮蔽 conftest 的真实 ``db_session`` fixture——后者绑定测试库、
    其 ``execute``/``get`` 是真实方法，无法被设置 ``return_value``/``side_effect``。
    """
    return MagicMock()


class TestRiskConstants:
    def test_constants_match_expected_values(self):
        assert IN_TRANSIT_STATUSES == ("in_transit", "draft")
        assert RISK_LONG_TERM_OUT_OF_STOCK == "长期断货"
        assert RISK_SHORT_TERM_OUT_OF_STOCK == "短期断货"
        assert RISK_OUT_OF_STOCK == "断货风险"
        assert RISK_HEALTHY == "健康库存"
        assert RISK_SLOW_MOVING == "滞销"
        assert RISK_SEVERE_SLOW_MOVING == "严重滞销"
        assert RISK_PENDING == "待补数据"


class TestGetProjectOr404:
    def test_returns_project_when_found(self, db_session: Session):
        mock_project = MagicMock(spec=Project)
        mock_project.id = 1
        mock_project.project_name = "Test"
        db_session.get.return_value = mock_project

        result = _get_project_or_404(db_session, 1)

        db_session.get.assert_called_once_with(Project, 1)
        assert result == mock_project

    def test_raises_404_when_not_found(self, db_session: Session):
        db_session.get.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            _get_project_or_404(db_session, 999)

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "项目不存在"


class TestPickBusinessSource:
    def test_returns_best_source_by_score(self, db_session: Session):
        today = date(2025, 6, 15)
        rows = [
            _make_source_file(1, date(2025, 5, 1), date(2025, 5, 30), 30),
            _make_source_file(2, date(2025, 5, 16), date(2025, 6, 14), 30),
        ]
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = rows
        mock_result = MagicMock()
        mock_result.scalars.return_value = mock_scalars
        db_session.execute.return_value = mock_result

        result = _pick_business_source(db_session, 1, "US", 30, today)

        assert result == rows[1]

    def test_returns_none_when_no_source(self, db_session: Session):
        mock_scalars = MagicMock()
        mock_scalars.all.return_value = []
        mock_result = MagicMock()
        mock_result.scalars.return_value = mock_scalars
        db_session.execute.return_value = mock_result

        result = _pick_business_source(db_session, 1, "US", 30, date.today())

        assert result is None


class TestLoadBaseSkus:
    def test_merges_product_and_setting_rows(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        project.project_name = "TestProject"
        project.country = "US"

        product_rows = [("SKU-001", "ASIN001", "US")]
        setting_rows = [("SKU-001", "ASIN002", "US"), ("SKU-002", None, "US")]

        mock_product_exec = MagicMock()
        mock_product_exec.all.return_value = product_rows
        mock_setting_exec = MagicMock()
        mock_setting_exec.all.return_value = setting_rows

        db_session.execute.side_effect = [mock_product_exec, mock_setting_exec]

        result = _load_base_skus(db_session, project, "US")

        assert len(result) == 2
        sku_map = {r.sku: r for r in result}
        assert "SKU-001" in sku_map
        assert "SKU-002" in sku_map

    def test_returns_empty_when_no_rows(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        project.project_name = "Empty"
        project.country = "US"

        mock_empty = MagicMock()
        mock_empty.all.return_value = []
        db_session.execute.return_value = mock_empty

        result = _load_base_skus(db_session, project, "US")

        assert result == []


class TestLoadSettingsMap:
    def test_returns_dict_keyed_by_sku_country(self, db_session: Session):
        s1 = MagicMock(spec=InventoryReplenishmentSetting)
        s1.sku = "SKU-A"
        s1.country = "US"
        s2 = MagicMock(spec=InventoryReplenishmentSetting)
        s2.sku = "SKU-B"
        s2.country = "US"
        rows = [s1, s2]

        mock_scalars = MagicMock()
        mock_scalars.all.return_value = rows
        mock_result = MagicMock()
        mock_result.scalars.return_value = mock_scalars
        db_session.execute.return_value = mock_result

        result = _load_settings_map(db_session, 1, "US")

        assert ("SKU-A", "US") in result
        assert result[("SKU-A", "US")] == s1


class TestLoadInventoryMap:
    def test_returns_empty_when_no_source(self, db_session: Session):
        mock_scalars = MagicMock()
        mock_scalars.first.return_value = None
        mock_result = MagicMock()
        mock_result.scalars.return_value = mock_scalars
        db_session.execute.return_value = mock_result

        result = _load_inventory_map(db_session, 1, "US")

        assert result == {}

    def test_returns_sku_quantity_map(self, db_session: Session):
        source = MagicMock(spec=AnalysisSourceFile)
        source.id = 10

        mock_scalars_first = MagicMock()
        mock_scalars_first.first.return_value = source
        mock_result_first = MagicMock()
        mock_result_first.scalars.return_value = mock_scalars_first

        quantity_rows = [("SKU-A", 100), ("SKU-B", 50)]
        mock_qty_exec = MagicMock()
        mock_qty_exec.all.return_value = quantity_rows

        db_session.execute.side_effect = [mock_result_first, mock_qty_exec]

        result = _load_inventory_map(db_session, 1, "US")

        assert result == {"SKU-A": 100, "SKU-B": 50}


class TestLoadInTransitMap:
    def test_returns_in_transit_quantities(self, db_session: Session):
        rows = [("SKU-A", 30), ("SKU-B", 15)]
        mock_exec = MagicMock()
        mock_exec.all.return_value = rows
        db_session.execute.return_value = mock_exec

        result = _load_in_transit_map(db_session, 1, "US")

        assert result == {"SKU-A": 30, "SKU-B": 15}

    def test_returns_empty_when_no_rows(self, db_session: Session):
        mock_exec = MagicMock()
        mock_exec.all.return_value = []
        db_session.execute.return_value = mock_exec

        result = _load_in_transit_map(db_session, 1, "DE")

        assert result == {}


class TestLoadAsinToSkusMap:
    def test_builds_asin_to_skus_mapping(self):
        rows = [
            _BaseSkuRow(sku="SKU-A", asin="ASIN001", country="US"),
            _BaseSkuRow(sku="SKU-B", asin="ASIN001", country="US"),
            _BaseSkuRow(sku="SKU-C", asin="ASIN002", country="US"),
            _BaseSkuRow(sku="SKU-D", asin=None, country="US"),
        ]

        result = _load_asin_to_skus_map(rows)

        assert result["ASIN001"] == {"SKU-A", "SKU-B"}
        assert result["ASIN002"] == {"SKU-C"}
        assert "ASIN000" not in result

    def test_returns_empty_when_no_asins(self):
        rows = [
            _BaseSkuRow(sku="SKU-A", asin=None, country="US"),
        ]
        assert _load_asin_to_skus_map(rows) == {}


class TestLoadSalesDmsMap:
    def test_computes_daily_mean_sales(self, db_session: Session):
        rows = [("SKU-A", 90), ("SKU-B", 45)]
        mock_exec = MagicMock()
        mock_exec.all.return_value = rows
        db_session.execute.return_value = mock_exec

        result = _load_sales_dms_map(db_session, 1, "US", date(2025, 6, 15), 30)

        assert result["SKU-A"] == Decimal("3")
        assert result["SKU-B"] == Decimal("1.5")


class TestLoadRecentSalesDmsMap:
    def test_delegates_to_sales_dms_with_recent_params(self, db_session: Session):
        rows = [("SKU-A", 9)]
        mock_exec = MagicMock()
        mock_exec.all.return_value = rows
        db_session.execute.return_value = mock_exec

        result = _load_recent_sales_dms_map(db_session, 1, "US", date(2025, 6, 15))

        assert "SKU-A" in result
        assert result["SKU-A"] == Decimal(9) / Decimal(RECENT_SALES_WINDOW_DAYS)


class TestNormalizeWeightedDms:
    def test_all_dms_provided(self):
        result = _normalize_weighted_dms(
            Decimal("10"), Decimal("12"), Decimal("15"), Decimal("20")
        )
        assert result is not None
        assert result > Decimal("13")

    def test_missing_dms_3_shifts_weight(self):
        result = _normalize_weighted_dms(
            Decimal("10"), Decimal("12"), Decimal("15"), None
        )
        assert result is not None
        assert result > Decimal("13")

    def test_all_none_returns_none(self):
        result = _normalize_weighted_dms(None, None, None, None)
        assert result is None

    def test_single_value_returns_that_value(self):
        result = _normalize_weighted_dms(None, None, Decimal("20"), None)
        assert result == Decimal("20")


class TestAddDays:
    def test_adds_days_to_date(self):
        base = date(2025, 1, 1)
        result = _add_days(base, Decimal("10"))
        assert result == "2025-01-11"

    def test_none_days_returns_none(self):
        assert _add_days(date.today(), None) is None


class TestSubtractDays:
    def test_subtracts_days(self):
        result = _subtract_days("2025-01-11", 10)
        assert result == "2025-01-01"

    def test_none_date_returns_none(self):
        assert _subtract_days(None, 5) is None


class TestClassifyRisk:
    def test_long_term_out_of_stock(self):
        today = date(2025, 6, 15)
        risk_date = (today - timedelta(days=1)).isoformat()
        result = _classify_risk(today, risk_date, Decimal("5"))
        assert result == RISK_LONG_TERM_OUT_OF_STOCK

    def test_short_term_out_of_stock(self):
        today = date(2025, 6, 15)
        risk_date = (today + timedelta(days=10)).isoformat()
        result = _classify_risk(today, risk_date, Decimal("5"))
        assert result == RISK_SHORT_TERM_OUT_OF_STOCK

    def test_out_of_stock_risk(self):
        today = date(2025, 6, 15)
        risk_date = (today + timedelta(days=30)).isoformat()
        result = _classify_risk(today, risk_date, Decimal("5"))
        assert result == RISK_OUT_OF_STOCK

    def test_healthy(self):
        today = date(2025, 6, 15)
        risk_date = (today + timedelta(days=60)).isoformat()
        result = _classify_risk(today, risk_date, Decimal("5"))
        assert result == RISK_HEALTHY

    def test_slow_moving(self):
        today = date(2025, 6, 15)
        risk_date = (today + timedelta(days=100)).isoformat()
        result = _classify_risk(today, risk_date, Decimal("5"))
        assert result == RISK_SLOW_MOVING

    def test_severe_slow_moving(self):
        today = date(2025, 6, 15)
        risk_date = (today + timedelta(days=150)).isoformat()
        result = _classify_risk(today, risk_date, Decimal("5"))
        assert result == RISK_SEVERE_SLOW_MOVING

    def test_pending_when_no_dms(self):
        today = date(2025, 6, 15)
        assert _classify_risk(today, "2025-07-01", None) == RISK_PENDING
        assert _classify_risk(today, "2025-07-01", Decimal("0")) == RISK_PENDING
        assert _classify_risk(today, None, Decimal("5")) == RISK_PENDING


class TestListInventoryReplenishmentAnalysis:
    def test_returns_analysed_data(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        project.project_name = "TestProject"
        db_session.get.return_value = project

        mock_settings_result = MagicMock()
        mock_settings_result.scalars.return_value.all.return_value = []
        mock_settings_result.scalars.return_value.first.return_value = None
        # BLF-502 S4：快照新鲜度查询（execute(...).first()）——无快照 → 0
        mock_settings_result.first.return_value = None

        mock_empty_exec = MagicMock()
        mock_empty_exec.all.return_value = []

        db_session.execute.return_value = mock_settings_result

        with (
            pytest.MonkeyPatch().context() as mp,
        ):

            def mock_today():
                return date(2025, 6, 15)

            mp.setattr(
                "app.services.inventory.replenishment.date",
                type("mock_date", (), {"today": staticmethod(mock_today)})(),
            )

            rows, summary, total, has_next = list_inventory_replenishment_analysis(
                db_session,
                project_id=1,
                country="US",
                keyword=None,
                risk_status=None,
                in_transit_only=False,
                page=1,
                page_size=50,
            )

        assert rows == []
        assert summary["sku_count"] == 0
        assert total == 0
        assert has_next is False


class TestUpsertInventoryReplenishmentSetting:
    def test_creates_new_setting(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        project.project_name = "Test"
        db_session.get.return_value = project

        mock_scalars = MagicMock()
        mock_scalars.first.return_value = None
        mock_result = MagicMock()
        mock_result.scalars.return_value = mock_scalars
        db_session.execute.return_value = mock_result

        db_session.refresh = MagicMock()

        result = upsert_inventory_replenishment_setting(
            db_session,
            project_id=1,
            sku="SKU-001",
            country="US",
            asin="ASIN001",
            production_lead_days=30,
            shipping_days=20,
            safety_factor=0.25,
            operator="admin",
        )

        db_session.add.assert_called_once()
        db_session.flush.assert_called_once()
        db_session.refresh.assert_called_once_with(result)

    def test_updates_existing_setting(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        project.project_name = "Test"
        db_session.get.return_value = project

        existing = MagicMock(spec=InventoryReplenishmentSetting)
        existing.id = 5
        existing.sku = "SKU-001"
        existing.country = "US"

        mock_scalars = MagicMock()
        mock_scalars.first.return_value = existing
        mock_result = MagicMock()
        mock_result.scalars.return_value = mock_scalars
        db_session.execute.return_value = mock_result

        db_session.refresh = MagicMock()

        result = upsert_inventory_replenishment_setting(
            db_session,
            project_id=1,
            sku="SKU-001",
            country="US",
            asin="ASIN999",
            production_lead_days=25,
            shipping_days=15,
            safety_factor=0.30,
            operator="admin",
        )

        db_session.add.assert_not_called()
        db_session.flush.assert_called_once()
        assert result == existing

    def test_raises_on_empty_sku(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        project.project_name = "Test"
        db_session.get.return_value = project

        with pytest.raises(HTTPException) as exc_info:
            upsert_inventory_replenishment_setting(
                db_session,
                project_id=1,
                sku="  ",
                country="US",
                asin=None,
                production_lead_days=20,
                shipping_days=25,
                safety_factor=0.2,
                operator="admin",
            )
        assert exc_info.value.status_code == 422


class TestListInventoryReplenishmentShipments:
    def test_returns_shipment_list(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        db_session.get.return_value = project

        schedule = MagicMock(spec=ShipmentSchedule)
        schedule.id = 100
        schedule.shipment_no = "SHIP-001"
        schedule.shipment_status = "in_transit"
        schedule.shipping_method = "sea"
        schedule.etd_date = None
        schedule.eta_date = None
        schedule.actual_inbound_date = None
        schedule.tracking_no = "TRACK123"
        schedule.updated_at = datetime(2025, 6, 15, 10, 0, 0)
        schedule.remark = None
        schedule.created_date = datetime(2025, 6, 10, 10, 0, 0)

        item = MagicMock(spec=ShipmentScheduleItem)
        item.quantity = 100
        item.remark = None

        mock_exec = MagicMock()
        mock_exec.all.return_value = [(schedule, item)]
        db_session.execute.return_value = mock_exec

        result = list_inventory_replenishment_shipments(
            db_session, project_id=1, sku="SKU-A"
        )

        assert len(result) == 1
        assert result[0]["schedule_id"] == 100
        assert result[0]["shipment_no"] == "SHIP-001"
        assert result[0]["quantity"] == 100

    def test_raises_on_empty_sku(self, db_session: Session):
        project = MagicMock(spec=Project)
        project.id = 1
        db_session.get.return_value = project

        with pytest.raises(HTTPException) as exc_info:
            list_inventory_replenishment_shipments(db_session, project_id=1, sku="  ")
        assert exc_info.value.status_code == 422


class TestListSnapshotOptions:
    def test_returns_options(self, db_session: Session):
        mock_first_result = MagicMock()
        mock_first_result.all.return_value = [MagicMock()]
        mock_first_scalars = MagicMock()
        mock_first_scalars.all.return_value = []
        mock_first_scalars_result = MagicMock()
        mock_first_scalars_result.scalars.return_value = mock_first_scalars

        mock_second_exec = MagicMock()
        mock_second_exec.all.return_value = []

        mock_third_result = MagicMock()
        mock_third_exec = MagicMock()
        third_row = MagicMock()
        third_row.report_date = date(2025, 6, 15)
        third_row.max_id = 42
        mock_third_exec.all.return_value = [third_row]

        db_session.execute.side_effect = [
            mock_first_scalars_result,
            mock_second_exec,
            mock_third_exec,
        ]

        result = list_snapshot_options(db_session, project_id=1, country="US")

        assert len(result) == 1
        assert result[0]["report_date"] == date(2025, 6, 15)
        assert result[0]["is_current"] is False


# ── Helpers ──────────────────────────────────────────────────────────


def _make_source_file(
    id: int,
    period_start: date,
    period_end: date,
    span_days: int,
) -> AnalysisSourceFile:
    sf = MagicMock(spec=AnalysisSourceFile)
    sf.id = id
    sf.period_start_date = period_start
    sf.period_end_date = period_end
    return sf

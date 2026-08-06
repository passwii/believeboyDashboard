"""Tests for ``app.services.rpa_report_service.get_report_status_for_date``.

Covers the RPA 状态矩阵 backend status source, in particular the two
inventory-ledger report types (``inventory_ledger_summary`` /
``inventory_ledger_detail``):

* Both types always appear in the per-project status output (frontend matrix
  columns are keyed on the same report_type strings).
* ``has_data`` for the ledger types is derived from the
  ``inventory_ledger_summary`` / ``inventory_ledger_detail`` tables (keyed by
  project_id + report_month = first-of-month), NOT from
  ``analysis_source_files`` — no source-file row is needed.
* ``is_uploaded`` still honors ``report_upload_logs`` (priority 1) and, like
  the existing backfill mechanism, is set when real data rows exist.
* Existing report types keep their current behavior.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, Project, ReportUploadLog
from app.models.inventory_ledger import InventoryLedgerDetail, InventoryLedgerSummary
from app.services.rpa_report_service import get_report_status_for_date


@pytest.fixture
def project(db_session: Session):
    """A throwaway active Project (admin sees all active projects)."""
    p = Project(
        project_name=f"rpa-status-test-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    db_session.add(p)
    db_session.flush()
    yield p
    db_session.rollback()


def _status_map(db: Session, project_id: int, report_date: str = "2026-06-15"):
    """Call the service and return {report_type: ReportTypeStatus} for a project."""
    resp = get_report_status_for_date(
        db, report_date=report_date, country="US", operator=None, is_admin=True
    )
    row = next(item for item in resp.items if item.project_id == project_id)
    return {st.report_type: st for st in row.statuses}


# ---------------------------------------------------------------------------
# Ledger types appear in the status output
# ---------------------------------------------------------------------------


class TestLedgerTypesInStatusOutput:
    def test_ledger_types_always_present_in_statuses(
        self, db_session: Session, project: Project
    ):
        """Both ledger columns exist even when nothing was uploaded/ingested."""
        statuses = _status_map(db_session, project.id)

        assert "inventory_ledger_summary" in statuses
        assert "inventory_ledger_detail" in statuses
        assert statuses["inventory_ledger_summary"].has_data is False
        assert statuses["inventory_ledger_summary"].is_uploaded is False
        assert statuses["inventory_ledger_detail"].has_data is False
        assert statuses["inventory_ledger_detail"].is_uploaded is False

    def test_summary_has_data_from_ledger_table_without_source_file(
        self, db_session: Session, project: Project
    ):
        """inventory_ledger_summary rows for the project+month ⇒ has_data=True.

        No analysis_source_files row and no upload log exist for this project,
        proving the ledger tables are the data source for this type.
        """
        db_session.add(
            InventoryLedgerSummary(
                project_id=project.id,
                report_month=date(2026, 6, 1),
                date=date(2026, 6, 10),
                msku="MSKU-001",
                disposition="SELLABLE",
                location="LAX1",
            )
        )
        db_session.flush()
        # Guard: nothing in the generic source-file path for this project
        assert (
            db_session.query(AnalysisSourceFile)
            .filter(AnalysisSourceFile.project_id == project.id)
            .count()
            == 0
        )

        st = _status_map(db_session, project.id)["inventory_ledger_summary"]
        assert st.has_data is True
        assert st.is_uploaded is True
        assert st.status_source == "business_date_backfill"
        assert st.latest_date == "2026-06-10"

    def test_detail_has_data_from_ledger_table_without_source_file(
        self, db_session: Session, project: Project
    ):
        """inventory_ledger_detail rows for the project+month ⇒ has_data=True."""
        db_session.add(
            InventoryLedgerDetail(
                project_id=project.id,
                report_month=date(2026, 6, 1),
                date=date(2026, 6, 12),
                msku="MSKU-001",
                event_type="Shipments",
                quantity=-1,
                fulfillment_center="LAX1",
                disposition="SELLABLE",
            )
        )
        db_session.flush()

        st = _status_map(db_session, project.id)["inventory_ledger_detail"]
        assert st.has_data is True
        assert st.is_uploaded is True
        assert st.latest_date == "2026-06-12"

    def test_ledger_report_month_is_first_of_month(
        self, db_session: Session, project: Project
    ):
        """report_date 2026-06-15 maps to report_month 2026-06-01 only.

        Rows for a different month (2026-07) must NOT light up the column.
        """
        db_session.add(
            InventoryLedgerSummary(
                project_id=project.id,
                report_month=date(2026, 7, 1),
                date=date(2026, 7, 1),
                msku="MSKU-001",
                disposition="SELLABLE",
                location="LAX1",
            )
        )
        db_session.flush()

        statuses = _status_map(db_session, project.id)
        assert statuses["inventory_ledger_summary"].has_data is False

        # Same report_date is a different month for a June call
        db_session.add(
            InventoryLedgerSummary(
                project_id=project.id,
                report_month=date(2026, 6, 1),
                date=date(2026, 6, 1),
                msku="MSKU-001",
                disposition="SELLABLE",
                location="LAX1",
            )
        )
        db_session.flush()
        assert _status_map(db_session, project.id)["inventory_ledger_summary"].has_data is True

    def test_ledger_upload_log_still_marks_uploaded(
        self, db_session: Session, project: Project
    ):
        """Priority 1: a report_upload_logs row for the ledger type wins."""
        db_session.add(
            ReportUploadLog(
                project_id=project.id,
                report_type="inventory_ledger_summary",
                country="US",
                upload_date=date(2026, 6, 15),
                has_real_data=True,
                original_filename="库存分类账-2026-06汇总视图.csv",
            )
        )
        db_session.flush()

        st = _status_map(db_session, project.id)["inventory_ledger_summary"]
        assert st.is_uploaded is True
        assert st.has_data is True
        assert st.status_source == "upload_log"


# ---------------------------------------------------------------------------
# Existing report types behave unchanged
# ---------------------------------------------------------------------------


class TestExistingTypesUnchanged:
    def test_business_report_source_file_backfill_unchanged(
        self, db_session: Session, project: Project
    ):
        """A periodic source file covering the target date still lights up."""
        db_session.add(
            AnalysisSourceFile(
                project_id=project.id,
                report_type="business_report",
                country="US",
                period_start_date=date(2026, 6, 1),
                period_end_date=date(2026, 6, 30),
                version=1,
                is_current=True,
                ingestion_status="success",
                row_count_total=42,
                upload_file_id="f1",
                upload_file_path="/tmp/f1.csv",
                stored_filename="f1.csv",
                logical_filename="f1.csv",
                storage_key="k/f1.csv",
            )
        )
        db_session.flush()

        st = _status_map(db_session, project.id)["business_report"]
        assert st.has_data is True
        assert st.is_uploaded is True
        assert st.status_source == "business_date_backfill"
        assert st.latest_date == "2026-06-30"

    def test_untouched_type_without_data_stays_false(
        self, db_session: Session, project: Project
    ):
        """inventory_report with no data at all stays red."""
        statuses = _status_map(db_session, project.id)
        assert statuses["inventory_report"].has_data is False
        assert statuses["inventory_report"].is_uploaded is False

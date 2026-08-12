"""Tests for ``app.services.rpa_report_service.get_report_status_for_date``.

Covers the RPA 状态矩阵 backend status source for the active 15 report
types (5 基础 + 10 广告). The two inventory-ledger report types
(``inventory_ledger_summary`` / ``inventory_ledger_detail``) were removed
from the matrix in BLF-649 — they no longer appear in the status output and
their ``has_data`` is no longer derived from the ledger tables.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy.orm import Session

from app.models import AnalysisSourceFile, Project, ReportUploadLog
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

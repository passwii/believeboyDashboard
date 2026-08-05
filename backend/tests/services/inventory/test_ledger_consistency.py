"""Tests for ``check_ledger_consistency`` (BEL-428 跨表对账).

Reconciles the Detailed view against the Summary truth table for a full
month: per (msku, location, disposition), sum(detail.quantity) must equal
(last summary ending_balance) − (first summary starting_balance).

Design notes (validated against real Amazon CSVs):
- Summary is the truth source; Detail is event-level.
- Amazon emits legitimate duplicate event tuples (same day/SKU/fc/type/qty)
  so detail has no event-tuple unique constraint.
- The monthly-aggregate comparison is what matched 0 mismatch across the
  4 manual reconciliation rounds; per-date comparison drifts because the
  summary is a daily snapshot whose event dates can lag detail.
"""

from __future__ import annotations

import io
import uuid
from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Project
from app.services.inventory.ledger import (
    check_ledger_consistency,
    ingest_ledger_csv,
)

_SUMMARY_HEADER = (
    "Date,FNSKU,ASIN,MSKU,Title,Disposition,Starting Warehouse Balance,"
    "In Transit Between Warehouses,Receipts,Customer Shipments,Customer Returns,"
    "Vendor Returns,Warehouse Transfer In/Out,Found,Lost,Damaged,Disposed,"
    "Other Events,Ending Warehouse Balance,Unknown Events,Location,Store"
)

_DETAIL_HEADER = (
    "Date,FNSKU,ASIN,MSKU,Title,Event Type,Reference ID,Quantity,"
    "Fulfillment Center,Disposition,Reason,Country,Reconciled Quantity,"
    "Unreconciled Quantity,Date and Time,Store"
)


def _summary_csv(rows: list[str]) -> str:
    return _SUMMARY_HEADER + "\n" + "\n".join(rows) + "\n"


def _summary_row(
    day: str,
    msku: str,
    starting: int,
    ending: int,
    location: str = "LAX1",
    disposition: str = "SELLABLE",
) -> str:
    return (
        f"{day},FN-{msku},B-{msku},{msku},Item {msku},{disposition},{starting},"
        f"0,0,0,0,0,0,0,0,0,0,0,{ending},0,{location},TestStore"
    )


def _detail_csv(rows: list[str]) -> str:
    return _DETAIL_HEADER + "\n" + "\n".join(rows) + "\n"


def _detail_row(
    day: str,
    msku: str,
    qty: int,
    fc: str = "LAX1",
    event_type: str = "Shipments",
    disposition: str = "SELLABLE",
) -> str:
    return (
        f"{day},FN-{msku},B-{msku},{msku},Item {msku},{event_type},,{qty},"
        f"{fc},{disposition},,US,,,2026-01-01T00:00:00-0700,"
    )


@pytest.fixture
def project(db_session: Session):
    p = Project(
        project_name=f"bel-428-consistency-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    db_session.add(p)
    db_session.flush()
    yield p
    db_session.execute(
        text("DELETE FROM inventory_ledger_detail WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_summary WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_ingest_batch WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.rollback()


def _ingest(db: Session, project_id: int, csv: str, filename: str) -> None:
    ingest_ledger_csv(db, project_id=project_id, csv_content=csv, filename=filename)
    db.commit()


class TestCheckLedgerConsistency:
    def test_no_data_pending(self, db_session: Session, project: Project):
        result = check_ledger_consistency(db_session, project.id, date(2026, 3, 1))
        assert result.status == "PENDING"
        assert result.mismatch_count == 0

    def test_summary_only_pending(self, db_session: Session, project: Project):
        """Summary present but no detail → can't reconcile, status OK (nothing
        to compare)."""
        _ingest(
            db_session,
            project.id,
            _summary_csv([_summary_row("03/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0301-0331.csv",
        )
        result = check_ledger_consistency(db_session, project.id, date(2026, 3, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0

    def test_consistent_month_ok(self, db_session: Session, project: Project):
        """detail sum (-5) == summary end - start (45 - 50 = -5) → OK."""
        _ingest(
            db_session,
            project.id,
            _summary_csv([_summary_row("03/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0301-0331.csv",
        )
        _ingest(
            db_session,
            project.id,
            _detail_csv(
                [
                    _detail_row("03/05/2026", "SKU-A", qty=-3),
                    _detail_row("03/20/2026", "SKU-A", qty=-2),
                ]
            ),
            "库存分类账-2026-03详细视图.csv",
        )
        result = check_ledger_consistency(db_session, project.id, date(2026, 3, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0

    def test_mismatch_detected(self, db_session: Session, project: Project):
        """detail sum (-7) != summary delta (-5) → MISMATCH with details."""
        _ingest(
            db_session,
            project.id,
            _summary_csv([_summary_row("03/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0301-0331.csv",
        )
        _ingest(
            db_session,
            project.id,
            _detail_csv(
                [
                    _detail_row("03/05/2026", "SKU-A", qty=-3),
                    _detail_row("03/20/2026", "SKU-A", qty=-4),
                ]
            ),
            "库存分类账-2026-03详细视图.csv",
        )
        result = check_ledger_consistency(db_session, project.id, date(2026, 3, 1))
        assert result.status == "MISMATCH"
        assert result.mismatch_count == 1
        m = result.mismatches[0]
        assert m.msku == "SKU-A"
        assert m.location == "LAX1"
        assert m.disposition == "SELLABLE"
        assert m.detail_quantity == -7
        assert m.summary_delta == -5
        assert m.diff == -2

    def test_detail_only_key_is_not_mismatch(
        self, db_session: Session, project: Project
    ):
        """A key that exists only in detail (sparse ledger) is skipped, not
        flagged — Amazon writes transfer events in detail that may not have a
        matching summary row that day."""
        _ingest(
            db_session,
            project.id,
            _summary_csv([_summary_row("03/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0301-0331.csv",
        )
        _ingest(
            db_session,
            project.id,
            _detail_csv(
                [
                    _detail_row("03/05/2026", "SKU-A", qty=-5),
                    _detail_row(
                        "03/07/2026",
                        "SKU-B",
                        qty=+1,
                        fc="STL3",
                        event_type="WhseTransfers",
                    ),
                ]
            ),
            "库存分类账-2026-03详细视图.csv",
        )
        result = check_ledger_consistency(db_session, project.id, date(2026, 3, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0

    def test_multiple_locations_and_dispositions(
        self, db_session: Session, project: Project
    ):
        """Same SKU in two (location, disposition) combos: one consistent,
        one broken — only the broken combo is reported."""
        _ingest(
            db_session,
            project.id,
            _summary_csv(
                [
                    _summary_row("03/01/2026", "SKU-A", starting=50, ending=45),
                    _summary_row(
                        "03/01/2026",
                        "SKU-A",
                        starting=20,
                        ending=18,
                        location="PHX3",
                        disposition="CUSTOMER_DAMAGED",
                    ),
                ]
            ),
            "库存分类账 2026-0301-0331.csv",
        )
        _ingest(
            db_session,
            project.id,
            _detail_csv(
                [
                    _detail_row("03/05/2026", "SKU-A", qty=-5),
                    _detail_row(
                        "03/06/2026",
                        "SKU-A",
                        qty=-1,
                        fc="PHX3",
                        event_type="VendorReturns",
                        disposition="CUSTOMER_DAMAGED",
                    ),
                    _detail_row(
                        "03/07/2026",
                        "SKU-A",
                        qty=-5,
                        fc="PHX3",
                        event_type="VendorReturns",
                        disposition="CUSTOMER_DAMAGED",
                    ),
                ]
            ),
            "库存分类账-2026-03详细视图.csv",
        )
        result = check_ledger_consistency(db_session, project.id, date(2026, 3, 1))
        assert result.status == "MISMATCH"
        assert result.mismatch_count == 1
        m = result.mismatches[0]
        assert (m.msku, m.location, m.disposition) == (
            "SKU-A",
            "PHX3",
            "CUSTOMER_DAMAGED",
        )
        assert m.detail_quantity == -6
        assert m.summary_delta == -2

    def test_january_wraps_month_end(self, db_session: Session, project: Project):
        """report_month=January resolves the month window correctly (31 days)."""
        _ingest(
            db_session,
            project.id,
            _summary_csv([_summary_row("01/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0101-0131.csv",
        )
        _ingest(
            db_session,
            project.id,
            _detail_csv([_detail_row("01/15/2026", "SKU-A", qty=-5)]),
            "库存分类账-2026-01详细视图.csv",
        )
        result = check_ledger_consistency(db_session, project.id, date(2026, 1, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0

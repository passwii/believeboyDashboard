"""Tests for ``check_ledger_integrity`` (BEL-417 P0 follow-up).

Regression background: the original implementation selected the current
month's first rows via ``date = (SELECT min(date) WHERE ...)`` — a
correlated scalar subquery that ``.correlate()`` collapsed into the outer
query, lifting ``min()`` into the outer WHERE. Postgres rejects that with
``GroupingError: aggregate functions are not allowed in WHERE``, so every
``/snapshot`` call for a full month where the project already had the
previous month's data returned 500 (and crashed the inventory-ledger
frontend page).

These tests pin the replacement (ROW_NUMBER ascending, rn == 1 — same
pattern as ``_eom_subquery``) against the real test Postgres.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Project
from app.services.inventory.ledger import check_ledger_integrity, ingest_ledger_csv

_LEDGER_HEADER = (
    "Date,FNSKU,ASIN,MSKU,Title,Disposition,Starting Warehouse Balance,"
    "In Transit Between Warehouses,Receipts,Customer Shipments,Customer Returns,"
    "Vendor Returns,Warehouse Transfer In/Out,Found,Lost,Damaged,Disposed,"
    "Other Events,Ending Warehouse Balance,Unknown Events,Location,Store"
)


def _ledger_row(
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


def _csv(rows: list[str]) -> str:
    return _LEDGER_HEADER + "\n" + "\n".join(rows) + "\n"


@pytest.fixture
def project(db_session: Session):
    """Throwaway project so concurrent tests don't trample each other."""
    p = Project(
        project_name=f"bel-417-integrity-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    db_session.add(p)
    db_session.flush()
    yield p
    db_session.execute(
        text("DELETE FROM inventory_ledger_raw WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.rollback()


def _ingest(db: Session, project_id: int, csv: str, filename: str) -> None:
    ingest_ledger_csv(db, project_id=project_id, csv_content=csv, filename=filename)
    db.commit()


class TestCheckLedgerIntegrity:
    def test_two_consecutive_months_ok(self, db_session: Session, project: Project):
        """THE BEL-417 P0 repro: two months of data used to raise
        ``psycopg.errors.GroupingError`` and 500 the snapshot endpoint."""
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("05/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0501-0531.csv",
        )
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("06/01/2026", "SKU-A", starting=45, ending=52)]),
            "库存分类账 2026-0601-0630.csv",
        )

        result = check_ledger_integrity(db_session, project.id, date(2026, 6, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0
        assert result.mismatches == []

    def test_mismatch_detected(self, db_session: Session, project: Project):
        """June starting (40) != May ending (45) → MISMATCH with details."""
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("05/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0501-0531.csv",
        )
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("06/01/2026", "SKU-A", starting=40, ending=48)]),
            "库存分类账 2026-0601-0630.csv",
        )

        result = check_ledger_integrity(db_session, project.id, date(2026, 6, 1))
        assert result.status == "MISMATCH"
        assert result.mismatch_count == 1
        m = result.mismatches[0]
        assert m.msku == "SKU-A"
        assert m.location == "LAX1"
        assert m.disposition == "SELLABLE"
        assert m.prev_ending == 45
        assert m.curr_starting == 40
        assert m.diff == -5

    def test_no_prev_month_pending(self, db_session: Session, project: Project):
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("06/01/2026", "SKU-A", starting=45, ending=52)]),
            "库存分类账 2026-0601-0630.csv",
        )
        result = check_ledger_integrity(db_session, project.id, date(2026, 6, 1))
        assert result.status == "PENDING"
        assert result.mismatch_count == 0

    def test_new_combination_in_curr_month_is_not_mismatch(
        self, db_session: Session, project: Project
    ):
        """A (msku, location, disposition) that first appears in the current
        month has no prev ending to compare — must be skipped, not flagged."""
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("05/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0501-0531.csv",
        )
        _ingest(
            db_session,
            project.id,
            _csv(
                [
                    _ledger_row("06/01/2026", "SKU-A", starting=45, ending=52),
                    _ledger_row("06/01/2026", "SKU-B", starting=10, ending=8),
                ]
            ),
            "库存分类账 2026-0601-0630.csv",
        )
        result = check_ledger_integrity(db_session, project.id, date(2026, 6, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0

    def test_partitions_by_location_and_disposition(
        self, db_session: Session, project: Project
    ):
        """Same SKU in two (location, disposition) combos: one continuous,
        one broken — only the broken combo is reported."""
        _ingest(
            db_session,
            project.id,
            _csv(
                [
                    _ledger_row("05/01/2026", "SKU-A", starting=50, ending=45),
                    _ledger_row(
                        "05/01/2026",
                        "SKU-A",
                        starting=20,
                        ending=18,
                        location="PHX3",
                        disposition="CUSTOMER_DAMAGED",
                    ),
                ]
            ),
            "库存分类账 2026-0501-0531.csv",
        )
        _ingest(
            db_session,
            project.id,
            _csv(
                [
                    _ledger_row("06/01/2026", "SKU-A", starting=45, ending=52),
                    _ledger_row(
                        "06/01/2026",
                        "SKU-A",
                        starting=99,
                        ending=90,
                        location="PHX3",
                        disposition="CUSTOMER_DAMAGED",
                    ),
                ]
            ),
            "库存分类账 2026-0601-0630.csv",
        )
        result = check_ledger_integrity(db_session, project.id, date(2026, 6, 1))
        assert result.status == "MISMATCH"
        assert result.mismatch_count == 1
        m = result.mismatches[0]
        assert (m.msku, m.location, m.disposition) == (
            "SKU-A",
            "PHX3",
            "CUSTOMER_DAMAGED",
        )
        assert m.prev_ending == 18
        assert m.curr_starting == 99

    def test_earliest_row_used_when_month_has_multiple_rows(
        self, db_session: Session, project: Project
    ):
        """Sparse ledger: the month's continuity anchor is the EARLIEST row's
        starting_balance, not later rows'. Guards the ascending rn==1 logic
        (a naive 'last row' or un-ordered pick would fail this)."""
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("05/01/2026", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2026-0501-0531.csv",
        )
        _ingest(
            db_session,
            project.id,
            _csv(
                [
                    _ledger_row("06/01/2026", "SKU-A", starting=45, ending=40),
                    # later row in the same month with a different balance —
                    # must NOT be used as the continuity anchor
                    _ledger_row("06/15/2026", "SKU-A", starting=40, ending=52),
                ]
            ),
            "库存分类账 2026-0601-0630.csv",
        )
        result = check_ledger_integrity(db_session, project.id, date(2026, 6, 1))
        assert result.status == "OK"
        assert result.mismatch_count == 0

    def test_january_wraps_to_previous_year(
        self, db_session: Session, project: Project
    ):
        """report_month=January → prev month is December of the prior year."""
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("12/01/2025", "SKU-A", starting=50, ending=45)]),
            "库存分类账 2025-1201-1231.csv",
        )
        _ingest(
            db_session,
            project.id,
            _csv([_ledger_row("01/01/2026", "SKU-A", starting=45, ending=52)]),
            "库存分类账 2026-0101-0131.csv",
        )
        result = check_ledger_integrity(db_session, project.id, date(2026, 1, 1))
        assert result.status == "OK"

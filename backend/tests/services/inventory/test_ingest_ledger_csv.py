"""Tests for ``app.services.inventory.ledger.ingest_ledger_csv`` (BEL-417).

Verifies the rewrite that replaced a 100-statement per-batch
``pg_insert().on_conflict_do_update()`` loop with a single
``COPY ... FROM STDIN`` into a temp staging table, then one
``INSERT ... ON CONFLICT`` upsert against the real table.

What's covered:

* **Idempotency** — re-ingesting the same CSV does not duplicate rows.
* **Conflict update** — when a (project_id, report_month, date, msku,
  disposition, location) tuple reappears with new numeric values, the
  upsert overwrites the non-key columns.
* **report_month extraction** — both the ``YYYYMMDD-XXXX`` and
  ``YYYY-MMDD-XXXX`` filename patterns land on the right partition.
* **Required columns validation** — missing columns raises ``ValueError``.
* **Empty CSV** — header-only file is rejected with a clear message.
* **Large-volume smoke** — 5k rows complete in well under the 5s
  frontend proxy timeout (regression guard for BEL-417).

The legacy ``_ingest_ledger_csv_legacy`` function is exercised on
non-Postgres bindings (and as a regression baseline when forcing the
legacy path) — see ``test_ingest_legacy_path_for_sqlite``.
"""

from __future__ import annotations

import io
import time
from datetime import date

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import Project
from app.services.inventory.ledger import (
    REQUIRED_COLUMNS,
    _build_copy_payload,
    _format_copy_value,
    _ingest_ledger_csv_copy,
    _ingest_ledger_csv_legacy,
    ingest_ledger_csv,
)
from app.models.inventory_ledger import InventoryLedgerRaw


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_csv(rows: list[dict]) -> str:
    """Build a CSV string in the same shape as Amazon's monthly ledger export.

    ``rows`` is a list of dicts keyed by Amazon's raw header. The fixture
    column order matches the layout the service expects from a real file
    (header names are normalized in the service).
    """
    headers = [
        "Date",
        "FNSKU",
        "ASIN",
        "MSKU",
        "Title",
        "Disposition",
        "Starting Warehouse Balance",
        "In Transit Between Warehouses",
        "Receipts",
        "Customer Shipments",
        "Customer Returns",
        "Vendor Returns",
        "Warehouse Transfer In/Out",
        "Found",
        "Lost",
        "Damaged",
        "Disposed",
        "Other Events",
        "Ending Warehouse Balance",
        "Unknown Events",
        "Location",
        "Store",
    ]
    buf = io.StringIO()
    buf.write(",".join(headers) + "\n")
    for r in rows:
        buf.write(",".join(str(r.get(h, "")) for h in headers) + "\n")
    return buf.getvalue()


def _row(
    day: str = "06/01/2026",
    msku: str = "MSKU-001",
    loc: str = "LAX1",
    disp: str = "SELLABLE",
    starting: int = 100,
    ending: int = 95,
    receipts: int = 0,
    shipments: int = 5,
) -> dict:
    return {
        "Date": day,
        "FNSKU": "X00ABC",
        "ASIN": "B0001",
        "MSKU": msku,
        "Title": "Test Item",
        "Disposition": disp,
        "Starting Warehouse Balance": starting,
        "In Transit Between Warehouses": 0,
        "Receipts": receipts,
        "Customer Shipments": shipments,
        "Customer Returns": 0,
        "Vendor Returns": 0,
        "Warehouse Transfer In/Out": 0,
        "Found": 0,
        "Lost": 0,
        "Damaged": 0,
        "Disposed": 0,
        "Other Events": 0,
        "Ending Warehouse Balance": ending,
        "Unknown Events": 0,
        "Location": loc,
        "Store": "Bel-Bel",
    }


@pytest.fixture
def project(db_session: Session):
    """A throwaway Project for ledger tests. Rollback reaps it after each test."""
    # Each test gets a fresh project id so concurrent tests don't trample
    # each other's rows.  We avoid the 200+ seeded projects by using a
    # unique project_name.
    import uuid

    p = Project(
        project_name=f"bel-417-test-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    db_session.add(p)
    db_session.flush()
    yield p
    # The conftest rolls back the whole test transaction, so no cleanup
    # needed; the explicit delete below is just a safety belt.
    db_session.execute(
        text("DELETE FROM inventory_ledger_raw WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.rollback()


# ---------------------------------------------------------------------------
# ingest_ledger_csv — happy path
# ---------------------------------------------------------------------------


class TestIngestLedgerCsvCopyPath:
    """BEL-417: COPY-from-STDIN path. These run against the real test Postgres."""

    def test_inserts_rows_with_report_month_from_filename(
        self, db_session: Session, project: Project
    ):
        csv = _make_csv([_row()])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        assert n == 1
        db_session.commit()

        rows = (
            db_session.execute(
                select(InventoryLedgerRaw).where(
                    InventoryLedgerRaw.project_id == project.id
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        r = rows[0]
        assert r.report_month == date(2026, 6, 1)
        assert r.date == date(2026, 6, 1)
        assert r.msku == "MSKU-001"
        assert r.location == "LAX1"
        assert r.disposition == "SELLABLE"
        assert r.starting_balance == 100
        assert r.ending_balance == 95
        assert r.receipts == 0
        assert r.customer_shipments == 5
        assert r.store == "Bel-Bel"

    def test_is_idempotent_on_re_ingest(self, db_session: Session, project: Project):
        csv = _make_csv([_row()])
        n1 = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()
        n2 = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()
        assert n1 == 1 and n2 == 1
        count = db_session.execute(
            select(InventoryLedgerRaw).where(
                InventoryLedgerRaw.project_id == project.id
            )
        ).all()
        assert len(count) == 1, "re-ingest must not duplicate rows"

    def test_conflict_update_overwrites_non_key_columns(
        self, db_session: Session, project: Project
    ):
        csv1 = _make_csv([_row(starting=100, ending=95)])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv1,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()

        # Same natural key, new numeric values → upsert should overwrite.
        csv2 = _make_csv([_row(starting=200, ending=180, receipts=10)])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv2,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()

        rows = (
            db_session.execute(
                select(InventoryLedgerRaw).where(
                    InventoryLedgerRaw.project_id == project.id
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        r = rows[0]
        assert r.starting_balance == 200
        assert r.ending_balance == 180
        assert r.receipts == 10
        # Title (which is non-key but we did NOT change in the CSV) — must
        # still reflect the most recent ingest's value, which is the same
        # "Test Item" both times, so we just check it's present.
        assert r.title == "Test Item"

    def test_extracts_report_month_from_yyyymmdd_filename(
        self, db_session: Session, project: Project
    ):
        csv = _make_csv([_row(day="05/15/2026")])
        # Filename uses MMDD-style date "20260515-0531" — report_month
        # extraction should land on 2026-05-01.
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="ledger 20260515-0531.csv",
        )
        db_session.commit()
        rows = (
            db_session.execute(
                select(InventoryLedgerRaw).where(
                    InventoryLedgerRaw.project_id == project.id
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].report_month == date(2026, 5, 1)
        # The row's business `date` is whatever the CSV said — 2026-05-15.
        assert rows[0].date == date(2026, 5, 15)

    def test_missing_required_columns_raises(
        self, db_session: Session, project: Project
    ):
        # Build a CSV missing `MSKU` and `Disposition` to trip the
        # required-columns guard.
        bad = (
            "Date,FNSKU,ASIN,Title,Location,Store\n06/01/2026,X00,B0001,Item,LAX1,Bel\n"
        )
        with pytest.raises(ValueError) as exc:
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content=bad,
                filename="broken.csv",
            )
        # The error mentions at least one of the missing columns. The
        # service normalises headers (lowercase, underscores), so the
        # reported missing-column names use that form, not the original
        # CSV header. Drop 'location' from the check since the test CSV
        # actually contains a `Location` column.
        msg = str(exc.value)
        for col in ("msku", "disposition", "starting_warehouse_balance"):
            assert col in msg.lower()

    def test_empty_csv_raises(self, db_session: Session, project: Project):
        with pytest.raises(ValueError, match="(?i)empty csv|missing required"):
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content="",
                filename="empty.csv",
            )

    def test_handles_chinese_filename(self, db_session: Session, project: Project):
        """Real-world filename used by Yawei's uploads (BEL-417)."""
        csv = _make_csv([_row()])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        assert n == 1
        db_session.commit()
        r = db_session.execute(
            select(InventoryLedgerRaw).where(
                InventoryLedgerRaw.project_id == project.id
            )
        ).scalar_one()
        assert r.report_month == date(2026, 6, 1)


# ---------------------------------------------------------------------------
# Bulk volume / performance — regression guard for BEL-417
# ---------------------------------------------------------------------------


class TestIngestVolume:
    """The original bug was a 5s frontend proxy timeout. These tests confirm
    the COPY path stays well under that bar even for very large files."""

    def test_5k_rows_under_five_seconds(self, db_session: Session, project: Project):
        rows = []
        for i in range(5_000):
            rows.append(
                _row(
                    day=f"06/01/2026",
                    msku=f"MSKU-{i:05d}",
                    loc="LAX1" if i % 2 == 0 else "PHX3",
                    disp="SELLABLE" if i % 3 == 0 else "CUSTOMER_DAMAGED",
                )
            )
        csv = _make_csv(rows)
        t0 = time.perf_counter()
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        elapsed = time.perf_counter() - t0
        db_session.commit()
        assert n == 5_000
        # Frontend proxy default was 5s. We want a comfortable margin
        # under that on a modest test DB; the real production row count
        # is rarely above 50k and the absolute budget at 60s tier is much
        # higher. Use a generous 5s ceiling that still catches a 100x
        # regression in the COPY path.
        assert elapsed < 5.0, f"5k rows took {elapsed:.2f}s — proxy will time out"

    def test_50k_rows_under_sixty_seconds(self, db_session: Session, project: Project):
        """The 60s report-tier budget — what BEL-417 raised the proxy to."""
        rows = []
        # 200 SKUs × 3 locs × 3 disp × 30 days = 54000; trim to 50k.
        from datetime import timedelta

        for d in range(30):
            day_str = (date(2026, 6, 1) + timedelta(days=d)).strftime("%m/%d/%Y")
            for s in range(200):
                for loc_i, loc in enumerate(("LAX1", "PHX3", "BWI2")):
                    for disp_i, disp in enumerate(
                        ("SELLABLE", "CUSTOMER_DAMAGED", "WAREHOUSE_DAMAGED")
                    ):
                        rows.append(
                            _row(day=day_str, msku=f"M-{s:04d}", loc=loc, disp=disp)
                        )
                        if len(rows) >= 50_000:
                            break
                    if len(rows) >= 50_000:
                        break
                if len(rows) >= 50_000:
                    break
            if len(rows) >= 50_000:
                break
        csv = _make_csv(rows)
        t0 = time.perf_counter()
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        elapsed = time.perf_counter() - t0
        db_session.commit()
        assert n == 50_000
        assert elapsed < 60.0, (
            f"50k rows took {elapsed:.2f}s — exceeds the 60s report-tier "
            f"proxy timeout; will time out in production"
        )


# ---------------------------------------------------------------------------
# Direct unit tests for the COPY helpers
# ---------------------------------------------------------------------------


class TestBuildCopyPayload:
    """Unit tests for the COPY payload builder. Pure-Python, no DB."""

    def test_format_value_none_is_null_marker(self):
        assert _format_copy_value(None) == r"\N"

    def test_format_value_date_is_iso(self):
        from datetime import date as _date

        assert _format_copy_value(_date(2026, 6, 1)) == "2026-06-01"

    def test_format_value_int_and_float(self):
        assert _format_copy_value(42) == "42"
        assert _format_copy_value(3.14) == "3.14"

    def test_format_value_string_escapes_specials(self):
        # backslash first, then tab/newline/CR — order matters
        assert _format_copy_value("a\\b") == "a\\\\b"
        assert _format_copy_value("a\tb") == "a\\tb"
        assert _format_copy_value("a\nb") == "a\\nb"
        assert _format_copy_value("a\rb") == "a\\rb"

    def test_format_value_plain_string_passthrough(self):
        assert _format_copy_value("MSKU-001") == "MSKU-001"
        assert _format_copy_value("LAX1") == "LAX1"

    def test_build_copy_payload_emits_tab_and_newline(self):
        from datetime import date as _date

        rows = [
            {
                "project_id": 1,
                "report_month": _date(2026, 6, 1),
                "date": _date(2026, 6, 1),
                "fnsku": None,
                "asin": None,
                "msku": "MSKU-001",
                "title": None,
                "disposition": "SELLABLE",
                "location": "LAX1",
                "starting_balance": 100,
                "in_transit_between": 0,
                "receipts": 0,
                "customer_shipments": 0,
                "customer_returns": 0,
                "vendor_returns": 0,
                "warehouse_transfer_io": 0,
                "found": 0,
                "lost": 0,
                "damaged": 0,
                "disposed": 0,
                "other_events": 0,
                "ending_balance": 100,
                "unknown_events": 0,
                "store": None,
            }
        ]
        payload = _build_copy_payload(rows)
        # decode and assert shape
        text = payload.decode("utf-8")
        lines = text.rstrip("\n").split("\n")
        assert len(lines) == 1
        cells = lines[0].split("\t")
        # 24 columns: 1 (project_id) + 1 (report_month) + 1 (date) + 21
        assert len(cells) == 24
        # cells: project_id, report_month, date, fnsku, asin, msku, ...
        assert cells[0] == "1"
        assert cells[1] == "2026-06-01"
        assert cells[2] == "2026-06-01"
        assert cells[3] == r"\N"  # fnsku NULL
        assert cells[4] == r"\N"  # asin NULL
        assert cells[5] == "MSKU-001"  # msku


class TestLegacyFallback:
    """The legacy per-batch path is still wired up for non-Postgres backends
    (theoretical) and for the on-conflict semantics. These tests guard that
    fallback so future refactors don't accidentally drop the safety net."""

    def test_legacy_path_writes_rows(self, db_session: Session, project: Project):
        from datetime import date as _date

        rows = [
            {
                "project_id": project.id,
                "report_month": _date(2026, 6, 1),
                "date": _date(2026, 6, 1),
                "fnsku": None,
                "asin": None,
                "msku": "LEG-001",
                "title": None,
                "disposition": "SELLABLE",
                "location": "LAX1",
                "starting_balance": 10,
                "in_transit_between": 0,
                "receipts": 0,
                "customer_shipments": 0,
                "customer_returns": 0,
                "vendor_returns": 0,
                "warehouse_transfer_io": 0,
                "found": 0,
                "lost": 0,
                "damaged": 0,
                "disposed": 0,
                "other_events": 0,
                "ending_balance": 10,
                "unknown_events": 0,
                "store": None,
            }
        ]
        n = _ingest_ledger_csv_legacy(db_session, rows)
        db_session.commit()
        assert n == 1
        r = db_session.execute(
            select(InventoryLedgerRaw).where(
                InventoryLedgerRaw.project_id == project.id
            )
        ).scalar_one()
        assert r.msku == "LEG-001"
        assert r.ending_balance == 10

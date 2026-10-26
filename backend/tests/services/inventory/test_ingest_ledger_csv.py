"""Tests for ``app.services.inventory.ledger.ingest_ledger_csv`` (BEL-428 双表).

Verifies the dual-table rewrite: Summary (真相源) + Detail (事件级) + ingest
batch metadata. Coverage:

* **Kind detection** — Summary vs Detailed by headers; unknown → ValueError.
* **Summary ingest** — rows land in ``inventory_ledger_summary`` with the
  batch id; idempotent re-ingest of the identical file returns 0 (batch
  file_hash dedupe) and does not duplicate rows.
* **Detail ingest** — rows land in ``inventory_ledger_detail``; legitimate
  duplicate event tuples are PRESERVED (no event-tuple unique constraint).
* **report_month extraction** — both ``YYYYMMDD-XXXX`` and
  ``库存分类账-2026-07详细视图.csv`` filename patterns land on the right
  partition.
* **Batch metadata** — one ``inventory_ledger_ingest_batch`` row per upload
  with kind / row counts / status.
* **Required columns validation** — missing columns raises ``ValueError``.
* **Large-volume smoke** — 5k rows complete quickly (BEL-417 regression guard).
"""

from __future__ import annotations

import io
import time
import uuid
from datetime import date

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.models import Project
from app.models.inventory_ledger import (
    InventoryLedgerDetail,
    InventoryLedgerIngestBatch,
    InventoryLedgerSummary,
)
from app.services.inventory.ledger import (
    DETAIL_REQUIRED_COLUMNS,
    SUMMARY_REQUIRED_COLUMNS,
    _build_copy_payload,
    _format_copy_value,
    detect_file_kind,
    get_sku_month_eom,
    get_sku_month_events,
    ingest_ledger_csv,
)

SUMMARY_HEADERS = [
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

DETAIL_HEADERS = [
    "Date",
    "FNSKU",
    "ASIN",
    "MSKU",
    "Title",
    "Event Type",
    "Reference ID",
    "Quantity",
    "Fulfillment Center",
    "Disposition",
    "Reason",
    "Country",
    "Reconciled Quantity",
    "Unreconciled Quantity",
    "Date and Time",
    "Store",
]


def _make_summary_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    buf.write(",".join(SUMMARY_HEADERS) + "\n")
    for r in rows:
        buf.write(",".join(str(r.get(h, "")) for h in SUMMARY_HEADERS) + "\n")
    return buf.getvalue()


def _make_detail_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    buf.write(",".join(DETAIL_HEADERS) + "\n")
    for r in rows:
        buf.write(",".join(str(r.get(h, "")) for h in DETAIL_HEADERS) + "\n")
    return buf.getvalue()


def _summary_row(
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


def _detail_row(
    day: str = "06/01/2026",
    msku: str = "MSKU-001",
    fc: str = "LAX1",
    disp: str = "SELLABLE",
    event_type: str = "Shipments",
    qty: int = -1,
    reference_id: str = "",
) -> dict:
    return {
        "Date": day,
        "FNSKU": "X00ABC",
        "ASIN": "B0001",
        "MSKU": msku,
        "Title": "Test Item",
        "Event Type": event_type,
        "Reference ID": reference_id,
        "Quantity": qty,
        "Fulfillment Center": fc,
        "Disposition": disp,
        "Reason": "",
        "Country": "US",
        "Reconciled Quantity": "",
        "Unreconciled Quantity": "",
        "Date and Time": f"2026-{day[3:5]}-{day[:2]}T00:00:00-0700",
        "Store": "",
    }


@pytest.fixture
def project(db_session: Session):
    """A throwaway Project for ledger tests. Rollback reaps it after each test."""
    p = Project(
        project_name=f"bel-428-test-{uuid.uuid4().hex[:8]}",
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


# ---------------------------------------------------------------------------
# Kind detection
# ---------------------------------------------------------------------------


class TestDetectFileKind:
    def test_summary_headers(self):
        assert detect_file_kind(SUMMARY_HEADERS) == "summary"

    def test_detail_headers(self):
        assert detect_file_kind(DETAIL_HEADERS) == "detail"

    def test_detail_wins_when_both_marker_sets_present(self):
        assert (
            detect_file_kind(
                SUMMARY_HEADERS + ["Event Type", "Quantity", "Fulfillment Center"]
            )
            == "detail"
        )

    def test_unknown_headers(self):
        assert detect_file_kind(["Date", "Foo", "Bar"]) == "unknown"


# ---------------------------------------------------------------------------
# ingest_ledger_csv — summary happy path
# ---------------------------------------------------------------------------


class TestIngestSummary:
    def test_accepts_month_only_date_and_numeric_filename(
        self, db_session: Session, project: Project
    ):
        """真实 Summary 导出 Date 为 MM/YYYY，文件名也可能只是纯数字。"""
        csv = _make_summary_csv([_summary_row(day="08/2026")])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="99538020752.csv",
            expected_kind="summary",
        )
        assert n == 1
        db_session.commit()

        r = (
            db_session.execute(
                select(InventoryLedgerSummary).where(
                    InventoryLedgerSummary.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert r.report_month == date(2026, 8, 1)
        assert r.date == date(2026, 8, 1)

    def test_month_only_summary_is_included_in_full_month_queries(
        self, db_session: Session, project: Project
    ):
        """选择 2026-08 时必须覆盖整月，不能因汇总日期归一为 08-01 而遗漏。"""
        csv = _make_summary_csv(
            [_summary_row(day="08/2026", starting=100, ending=95, receipts=3)]
        )
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="99538020752.csv",
            expected_kind="summary",
        )

        eom = get_sku_month_eom(
            db_session,
            project.id,
            date(2026, 8, 1),
            date(2026, 8, 31),
        )
        events = get_sku_month_events(
            db_session,
            project.id,
            date(2026, 8, 1),
            date(2026, 8, 31),
        )

        assert len(eom) == 1
        assert eom[0].qty_eom == 95
        assert len(events) == 1
        assert events[0].total_receipts == 3

    def test_inserts_rows_with_report_month_from_filename(
        self, db_session: Session, project: Project
    ):
        csv = _make_summary_csv([_summary_row()])
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
                select(InventoryLedgerSummary).where(
                    InventoryLedgerSummary.project_id == project.id
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
        assert r.batch_id is not None

    def test_creates_ingest_batch_with_metadata(
        self, db_session: Session, project: Project
    ):
        csv = _make_summary_csv([_summary_row()])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
            loaded_by="test-operator",
        )
        db_session.commit()
        batch = (
            db_session.execute(
                select(InventoryLedgerIngestBatch).where(
                    InventoryLedgerIngestBatch.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert batch.file_kind == "summary"
        assert batch.status == "success"
        assert batch.rows_parsed == 1
        assert batch.rows_written_summary == 1
        assert batch.rows_written_detail == 0
        assert batch.loaded_by == "test-operator"
        assert batch.consistency_check is None  # not run by ingest itself

    def test_reingest_same_file_is_idempotent(
        self, db_session: Session, project: Project
    ):
        csv = _make_summary_csv([_summary_row()])
        n1 = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()
        # Identical bytes + filename → same batch file_hash → skipped.
        n2 = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()
        assert n1 == 1 and n2 == 0
        count = db_session.execute(
            select(InventoryLedgerSummary).where(
                InventoryLedgerSummary.project_id == project.id
            )
        ).all()
        assert len(count) == 1, "re-ingest must not duplicate rows"
        batches = (
            db_session.execute(
                select(InventoryLedgerIngestBatch).where(
                    InventoryLedgerIngestBatch.project_id == project.id
                )
            )
            .scalars()
            .all()
        )
        assert len(batches) == 1, "same file → same batch row"

    def test_rewrite_after_failed_batch(self, db_session: Session, project: Project):
        """A failed batch row is reused on retry (natural-key upsert)."""
        # First ingest a valid file → success batch.
        csv = _make_summary_csv([_summary_row()])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()

        # Simulate a failed batch (same natural key) then re-ingest: the batch
        # row is reused, not duplicated.
        batch = (
            db_session.execute(
                select(InventoryLedgerIngestBatch).where(
                    InventoryLedgerIngestBatch.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        batch.status = "failed"
        batch.error_message = "boom"
        db_session.commit()

        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
        )
        db_session.commit()
        assert n == 1
        batches = (
            db_session.execute(
                select(InventoryLedgerIngestBatch).where(
                    InventoryLedgerIngestBatch.project_id == project.id
                )
            )
            .scalars()
            .all()
        )
        assert len(batches) == 1
        assert batches[0].status == "success"


# ---------------------------------------------------------------------------
# ingest_ledger_csv — detail happy path
# ---------------------------------------------------------------------------


class TestIngestDetail:
    def test_numeric_filename_falls_back_to_csv_dates(
        self, db_session: Session, project: Project
    ):
        """纯数字文件名不能被当成 YYYYMMDD 而生成非法 report_month。"""
        csv = _make_detail_csv([_detail_row(day="08/31/2026")])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="99539020752.csv",
            expected_kind="detail",
        )
        assert n == 1
        db_session.commit()

        r = (
            db_session.execute(
                select(InventoryLedgerDetail).where(
                    InventoryLedgerDetail.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert r.report_month == date(2026, 8, 1)
        assert r.date == date(2026, 8, 31)

    def test_inserts_detail_rows(self, db_session: Session, project: Project):
        csv = _make_detail_csv([_detail_row()])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-06详细视图.csv",
        )
        assert n == 1
        db_session.commit()

        rows = (
            db_session.execute(
                select(InventoryLedgerDetail).where(
                    InventoryLedgerDetail.project_id == project.id
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        r = rows[0]
        assert r.report_month == date(2026, 6, 1)
        assert r.event_type == "Shipments"
        assert r.quantity == -1
        assert r.fulfillment_center == "LAX1"
        assert r.disposition == "SELLABLE"
        assert r.batch_id is not None
        batch = db_session.get(InventoryLedgerIngestBatch, r.batch_id)
        assert batch is not None and batch.file_kind == "detail"

    def test_preserves_duplicate_event_tuples(
        self, db_session: Session, project: Project
    ):
        """BEL-428 design decision: Amazon emits legitimate duplicate event
        tuples (same day/SKU/fc/type/qty). No unique constraint on the event
        tuple → all rows must be preserved."""
        csv = _make_detail_csv(
            [
                _detail_row(day="06/01/2026", msku="MSKU-001", fc="LAX1"),
                _detail_row(day="06/01/2026", msku="MSKU-001", fc="LAX1"),
                _detail_row(day="06/01/2026", msku="MSKU-001", fc="LAX1"),
            ]
        )
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-06详细视图.csv",
        )
        db_session.commit()
        assert n == 3
        count = db_session.execute(
            select(InventoryLedgerDetail).where(
                InventoryLedgerDetail.project_id == project.id
            )
        ).all()
        assert len(count) == 3, "identical event tuples must all be kept"

    def test_detail_reingest_same_file_skipped(
        self, db_session: Session, project: Project
    ):
        csv = _make_detail_csv([_detail_row()])
        n1 = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-06详细视图.csv",
        )
        db_session.commit()
        n2 = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-06详细视图.csv",
        )
        db_session.commit()
        assert n1 == 1 and n2 == 0
        count = db_session.execute(
            select(InventoryLedgerDetail).where(
                InventoryLedgerDetail.project_id == project.id
            )
        ).all()
        assert len(count) == 1


# ---------------------------------------------------------------------------
# Filename → report_month extraction
# ---------------------------------------------------------------------------


class TestReportMonthExtraction:
    def test_yyyymmdd_filename(self, db_session: Session, project: Project):
        csv = _make_summary_csv([_summary_row(day="05/15/2026")])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="ledger 20260515-0531.csv",
        )
        db_session.commit()
        r = (
            db_session.execute(
                select(InventoryLedgerSummary).where(
                    InventoryLedgerSummary.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert r.report_month == date(2026, 5, 1)
        assert r.date == date(2026, 5, 15)

    def test_chinese_dash_filename(self, db_session: Session, project: Project):
        """Real-world filename: 库存分类账-2026-07详细视图.csv"""
        csv = _make_detail_csv([_detail_row(day="07/10/2026")])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-07详细视图.csv",
        )
        db_session.commit()
        r = (
            db_session.execute(
                select(InventoryLedgerDetail).where(
                    InventoryLedgerDetail.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert r.report_month == date(2026, 7, 1)

    def test_chinese_space_filename(self, db_session: Session, project: Project):
        """Real-world filename: 库存分类账 2026-01一览视图.csv"""
        csv = _make_summary_csv([_summary_row(day="01/31/2026")])
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-01一览视图.csv",
        )
        db_session.commit()
        r = (
            db_session.execute(
                select(InventoryLedgerSummary).where(
                    InventoryLedgerSummary.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert r.report_month == date(2026, 1, 1)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestValidation:
    def test_missing_summary_columns_raises(
        self, db_session: Session, project: Project
    ):
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
        msg = str(exc.value).lower()
        for col in ("msku", "disposition", "starting_warehouse_balance"):
            assert col in msg

    def test_missing_detail_columns_raises(self, db_session: Session, project: Project):
        bad = "Date,FNSKU,ASIN,MSKU,Title,Quantity\n06/01/2026,X,B1,M,Item,-1\n"
        with pytest.raises(ValueError) as exc:
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content=bad,
                filename="broken.csv",
            )
        msg = str(exc.value).lower()
        assert "event_type" in msg or "fulfillment_center" in msg

    def test_unknown_kind_raises(self, db_session: Session, project: Project):
        with pytest.raises(ValueError, match="无法识别报表类型"):
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content="Date,Foo,Bar\n01/01/2026,a,b\n",
                filename="weird.csv",
            )

    def test_empty_csv_raises(self, db_session: Session, project: Project):
        with pytest.raises(ValueError, match="(?i)empty csv|missing required"):
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content="",
                filename="empty.csv",
            )

    def test_all_rows_with_invalid_dates_raise_instead_of_returning_zero(
        self, db_session: Session, project: Project
    ):
        """所有行日期解析失败时必须报错，不能以“成功入库 0 行”掩盖问题。"""
        csv = _make_summary_csv([_summary_row(day="2026/08/31")])
        with pytest.raises(ValueError, match="日期|Date"):
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content=csv,
                filename="库存分类账.csv",
                expected_kind="summary",
            )

    def test_missing_required_summary_columns_constant(self):
        assert SUMMARY_REQUIRED_COLUMNS == {
            "date",
            "msku",
            "disposition",
            "location",
            "starting_warehouse_balance",
            "ending_warehouse_balance",
        }

    def test_missing_required_detail_columns_constant(self):
        assert DETAIL_REQUIRED_COLUMNS == {
            "date",
            "msku",
            "event_type",
            "quantity",
            "fulfillment_center",
            "disposition",
        }


# ---------------------------------------------------------------------------
# Typed ingest contract — expected_kind 声明与文件内容必须一致 (Task 2)
# ---------------------------------------------------------------------------


class TestTypedIngestContract:
    """声明类型（expected_kind）与 CSV 表头检测结果不一致时必须拒绝。

    调用方（HTTP persistence）把声明类型与文件内容不一致视为结构化 4xx，
    因此这里必须抛 ``ValueError`` 且消息含"类型与文件内容不一致"。
    """

    def test_expected_summary_rejects_detail_csv(
        self, db_session: Session, project: Project
    ):
        csv = _make_detail_csv([_detail_row()])
        with pytest.raises(ValueError, match="类型与文件内容不一致") as exc:
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content=csv,
                filename="库存分类账-2026-06详细视图.csv",
                expected_kind="summary",
            )
        msg = str(exc.value)
        assert "summary" in msg and "detail" in msg, msg

    def test_expected_detail_rejects_summary_csv(
        self, db_session: Session, project: Project
    ):
        csv = _make_summary_csv([_summary_row()])
        with pytest.raises(ValueError, match="类型与文件内容不一致") as exc:
            ingest_ledger_csv(
                db_session,
                project_id=project.id,
                csv_content=csv,
                filename="库存分类账 2026-0601-0630.csv",
                expected_kind="detail",
            )
        msg = str(exc.value)
        assert "summary" in msg and "detail" in msg, msg

    def test_expected_summary_with_summary_csv_ingests_summary_table(
        self, db_session: Session, project: Project
    ):
        csv = _make_summary_csv([_summary_row()])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
            expected_kind="summary",
        )
        assert n == 1
        db_session.commit()
        summary_rows = db_session.execute(
            select(InventoryLedgerSummary).where(
                InventoryLedgerSummary.project_id == project.id
            )
        ).all()
        detail_rows = db_session.execute(
            select(InventoryLedgerDetail).where(
                InventoryLedgerDetail.project_id == project.id
            )
        ).all()
        assert len(summary_rows) == 1
        assert len(detail_rows) == 0

    def test_expected_detail_with_detail_csv_ingests_detail_table(
        self, db_session: Session, project: Project
    ):
        csv = _make_detail_csv([_detail_row()])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-06详细视图.csv",
            expected_kind="detail",
        )
        assert n == 1
        db_session.commit()
        summary_rows = db_session.execute(
            select(InventoryLedgerSummary).where(
                InventoryLedgerSummary.project_id == project.id
            )
        ).all()
        detail_rows = db_session.execute(
            select(InventoryLedgerDetail).where(
                InventoryLedgerDetail.project_id == project.id
            )
        ).all()
        assert len(summary_rows) == 0
        assert len(detail_rows) == 1

    def test_expected_kind_none_keeps_autodetect_legacy_path(
        self, db_session: Session, project: Project
    ):
        """兼容旧调用：不传 expected_kind 时保持按表头自动识别。"""
        csv = _make_summary_csv([_summary_row()])
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账 2026-0601-0630.csv",
            expected_kind=None,
        )
        assert n == 1


# ---------------------------------------------------------------------------
# Bulk volume / performance — regression guard for BEL-417
# ---------------------------------------------------------------------------


class TestIngestVolume:
    def test_5k_summary_rows_under_five_seconds(
        self, db_session: Session, project: Project
    ):
        rows = []
        for i in range(5_000):
            rows.append(
                _summary_row(
                    day="06/01/2026",
                    msku=f"MSKU-{i:05d}",
                    loc="LAX1" if i % 2 == 0 else "PHX3",
                    disp="SELLABLE" if i % 3 == 0 else "CUSTOMER_DAMAGED",
                )
            )
        csv = _make_summary_csv(rows)
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
        assert elapsed < 5.0, f"5k rows took {elapsed:.2f}s — proxy will time out"

    def test_5k_detail_rows_under_five_seconds(
        self, db_session: Session, project: Project
    ):
        rows = []
        for i in range(5_000):
            rows.append(
                _detail_row(
                    day="06/01/2026",
                    msku=f"MSKU-{i:05d}",
                    fc="LAX1" if i % 2 == 0 else "PHX3",
                )
            )
        csv = _make_detail_csv(rows)
        t0 = time.perf_counter()
        n = ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=csv,
            filename="库存分类账-2026-06详细视图.csv",
        )
        elapsed = time.perf_counter() - t0
        db_session.commit()
        assert n == 5_000
        assert elapsed < 5.0, f"5k detail rows took {elapsed:.2f}s"


# ---------------------------------------------------------------------------
# COPY payload helpers (pure Python, no DB)
# ---------------------------------------------------------------------------


class TestBuildCopyPayload:
    def test_format_value_none_is_null_marker(self):
        assert _format_copy_value(None) == r"\N"

    def test_format_value_date_is_iso(self):
        from datetime import date as _date

        assert _format_copy_value(_date(2026, 6, 1)) == "2026-06-01"

    def test_format_value_int_and_float(self):
        assert _format_copy_value(42) == "42"
        assert _format_copy_value(3.14) == "3.14"

    def test_format_value_string_escapes_specials(self):
        assert _format_copy_value("a\\b") == "a\\\\b"
        assert _format_copy_value("a\tb") == "a\\tb"
        assert _format_copy_value("a\nb") == "a\\nb"
        assert _format_copy_value("a\rb") == "a\\rb"

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
                "batch_id": None,
            }
        ]
        payload = _build_copy_payload(
            rows,
            (
                "project_id",
                "report_month",
                "date",
                "fnsku",
                "asin",
                "msku",
                "title",
                "disposition",
                "location",
                "starting_balance",
                "in_transit_between",
                "receipts",
                "customer_shipments",
                "customer_returns",
                "vendor_returns",
                "warehouse_transfer_io",
                "found",
                "lost",
                "damaged",
                "disposed",
                "other_events",
                "ending_balance",
                "unknown_events",
                "store",
                "batch_id",
            ),
        )
        text_payload = payload.decode("utf-8")
        lines = text_payload.rstrip("\n").split("\n")
        assert len(lines) == 1
        cells = lines[0].split("\t")
        assert len(cells) == 25
        assert cells[0] == "1"
        assert cells[1] == "2026-06-01"
        assert cells[5] == "MSKU-001"
        assert cells[24] == r"\N"  # batch_id NULL

"""Tests for ``GET /api/v1/inventory-ledger/batches`` (ingest batch traceability).

Regression for the production 500: ``list_ingest_batches`` returns ORM
``InventoryLedgerIngestBatch`` rows, and the endpoint passed them straight
into ``IngestBatchesResponse(batches=...)`` without conversion — Pydantic v2
rejects bare ORM objects unless ``model_validate`` + ``from_attributes`` are
used, so the first real upload (non-empty batch table) exploded with a 500.
"""

from __future__ import annotations

import io
import uuid
from datetime import date

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.endpoints.inventory_ledger import list_batches
from app.models import Project
from app.models.inventory_ledger import InventoryLedgerIngestBatch
from app.schemas.inventory_ledger import (
    IngestBatchInfo,
    IngestBatchesResponse,
)
from app.services.inventory.ledger import ingest_ledger_csv

SUMMARY_CSV = (
    "Date,FNSKU,ASIN,MSKU,Title,Disposition,"
    "Starting Warehouse Balance,In Transit Between Warehouses,Receipts,"
    "Customer Shipments,Customer Returns,Vendor Returns,"
    "Warehouse Transfer In/Out,Found,Lost,Damaged,Disposed,Other Events,"
    "Ending Warehouse Balance,Unknown Events,Location,Store\n"
    '03/31/2026,"X003Z1UMF5","B0CJF8GL1H","MJQ-TR250E","T","SELLABLE",'
    '1,0,0,0,0,0,0,0,0,0,0,0,1,0,"MCO2",\n'
)


@pytest.fixture
def project(db_session: Session):
    """A throwaway Project for the batches endpoint tests."""
    p = Project(
        project_name=f"bel-batches-test-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    db_session.add(p)
    db_session.flush()
    yield p
    db_session.execute(
        text(
            "DELETE FROM inventory_ledger_ingest_batch WHERE project_id = :pid"
        ),
        {"pid": p.id},
    )
    db_session.rollback()


class TestIngestBatchInfoFromOrm:
    """ORM → schema conversion must work (from_attributes)."""

    def test_model_validate_accepts_orm_instance(self, db_session: Session):
        from datetime import datetime, timezone

        batch = InventoryLedgerIngestBatch(
            id=1,
            project_id=42,
            report_month=date(2026, 3, 1),
            source_filename="库存分类账 2026-03一览视图.csv",
            file_hash="abc123",
            file_size_bytes=1024,
            file_kind="summary",
            loaded_by="test-operator",
            loaded_at=datetime.now(timezone.utc),
            status="success",
            rows_parsed=10,
            rows_written_summary=10,
            rows_written_detail=0,
            rows_skipped_duplicate=0,
            rows_failed_validation=0,
            consistency_mismatch_count=0,
        )
        info = IngestBatchInfo.model_validate(batch)
        assert info.file_kind == "summary"
        assert info.report_month == date(2026, 3, 1)
        assert info.source_filename == "库存分类账 2026-03一览视图.csv"


class TestListBatchesEndpoint:
    """End-to-end: ingest a real CSV, then list batches via the endpoint fn."""

    def test_endpoint_returns_batches_after_ingest(
        self, db_session: Session, project: Project
    ):
        ingest_ledger_csv(
            db_session,
            project_id=project.id,
            csv_content=io.BytesIO(SUMMARY_CSV.encode("utf-8")).getvalue(),
            filename="库存分类账 2026-03一览视图.csv",
            expected_kind="summary",
            loaded_by="test-operator",
        )
        db_session.commit()

        response = list_batches(project_id=project.id, limit=100, db=db_session)
        assert isinstance(response, IngestBatchesResponse)
        assert response.project_id == project.id
        assert len(response.batches) == 1
        batch = response.batches[0]
        assert batch.file_kind == "summary"
        assert batch.rows_written_summary == 1
        assert batch.status == "success"

"""Full-month inventory ledger analysis contract used by the dashboard export."""

from __future__ import annotations

import uuid
from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.v1.endpoints.inventory_ledger import get_month_analysis
from app.models import Project
from app.services.inventory.ledger import (
    get_ledger_detail_rows,
    get_ledger_summary_rows,
    ingest_ledger_csv,
)

SUMMARY_HEADERS = (
    "Date,FNSKU,ASIN,MSKU,Title,Disposition,Starting Warehouse Balance,"
    "In Transit Between Warehouses,Receipts,Customer Shipments,Customer Returns,"
    "Vendor Returns,Warehouse Transfer In/Out,Found,Lost,Damaged,Disposed,"
    "Other Events,Ending Warehouse Balance,Unknown Events,Location,Store"
)

DETAIL_HEADERS = (
    "Date,FNSKU,ASIN,MSKU,Title,Event Type,Reference ID,Quantity,"
    "Fulfillment Center,Disposition,Reason,Country,Reconciled Quantity,"
    "Unreconciled Quantity,Date and Time,Store"
)


def _summary_csv() -> str:
    return (
        SUMMARY_HEADERS
        + "\n"
        + "08/2026,FN-A,B-A,SKU-A,Item A,SELLABLE,10,0,2,-1,0,0,0,0,0,0,0,0,11,0,LAX1,Store\n"
        + "08/2026,FN-B,B-B,SKU-B,Item B,CUSTOMER_DAMAGED,2,0,0,0,0,0,0,0,0,0,0,0,2,0,SCK8,Store\n"
    )


def _detail_csv() -> str:
    return (
        DETAIL_HEADERS
        + "\n"
        + "08/02/2026,FN-A,B-A,SKU-A,Item A,Receipts,REF-1,2,LAX1,SELLABLE,,US,,,2026-08-02T00:00:00-0700,Store\n"
        + "08/03/2026,FN-A,B-A,SKU-A,Item A,Shipments,REF-2,-1,LAX1,SELLABLE,,US,,,2026-08-03T00:00:00-0700,Store\n"
    )


@pytest.fixture
def project(db_session: Session):
    row = Project(
        project_name=f"ledger-month-analysis-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
        country="US",
    )
    db_session.add(row)
    db_session.flush()
    yield row
    db_session.execute(
        text("DELETE FROM inventory_ledger_detail WHERE project_id = :pid"),
        {"pid": row.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_summary WHERE project_id = :pid"),
        {"pid": row.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_ingest_batch WHERE project_id = :pid"),
        {"pid": row.id},
    )
    db_session.rollback()


def _seed(db: Session, project_id: int) -> None:
    ingest_ledger_csv(
        db,
        project_id=project_id,
        csv_content=_summary_csv(),
        filename="99538020752.csv",
        expected_kind="summary",
    )
    ingest_ledger_csv(
        db,
        project_id=project_id,
        csv_content=_detail_csv(),
        filename="99539020752.csv",
        expected_kind="detail",
    )
    db.commit()


def test_unlimited_row_queries_return_all_seeded_rows(
    db_session: Session, project: Project
):
    _seed(db_session, project.id)

    summary_rows = get_ledger_summary_rows(
        db_session,
        project.id,
        date(2026, 8, 1),
        date(2026, 8, 31),
        limit=None,
    )
    detail_rows = get_ledger_detail_rows(
        db_session,
        project.id,
        date(2026, 8, 1),
        date(2026, 8, 31),
        limit=None,
    )

    assert len(summary_rows) == 2
    assert len(detail_rows) == 2


def test_month_analysis_returns_full_rows_and_nested_results(
    db_session: Session,
    project: Project,
):
    _seed(db_session, project.id)

    body = get_month_analysis(
        project_id=project.id,
        period="2026-08",
        db=db_session,
    )

    assert body.project_id == project.id
    assert body.project_name == project.project_name
    assert body.report_month == date(2026, 8, 1)
    assert body.start_date == date(2026, 8, 1)
    assert body.end_date == date(2026, 8, 31)
    assert len(body.summary_rows) == 2
    assert len(body.detail_rows) == 2
    assert body.snapshot.total_qty == 13
    assert body.trend.months[-1].report_month == "2026-08"
    assert body.consistency.status == "OK"
    assert {batch.file_kind for batch in body.batches} == {
        "summary",
        "detail",
    }


def test_month_analysis_rejects_partial_period(
    db_session: Session,
    project: Project,
):
    with pytest.raises(HTTPException) as exc:
        get_month_analysis(
            project_id=project.id,
            period="30d",
            db=db_session,
        )

    assert exc.value.status_code == 400
    assert "full calendar month" in str(exc.value.detail)

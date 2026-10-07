"""BLF-1262 Stage 2: generated fulfillment-channel parity and aggregate semantics."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project
from app.services.data import order_info_service as svc
from app.utils.sales_amount import sales_amount_expr_by_row


def _seed_order_rows(db: Session) -> dict:
    project = Project(
        project_name=f"blf1266-fulfillment-{uuid.uuid4().hex[:8]}",
        project_operator="pytest",
        sort_order=0,
        is_active=True,
    )
    db.add(project)
    db.flush()

    today = date.today()
    source = AnalysisSourceFile(
        project_id=project.id,
        country="US",
        report_type="sales_report",
        upload_file_id=f"blf1266_{uuid.uuid4().hex[:12]}",
        upload_file_path="/tmp/blf1266.csv",
        original_filename="blf1266.csv",
        stored_filename="blf1266.csv",
        logical_filename="blf1266.csv",
        storage_key=f"blf1266/{uuid.uuid4().hex}",
        period_start_date=today,
        period_end_date=today,
        is_current=True,
        ingestion_status="success",
        created_by="pytest",
    )
    db.add(source)
    db.flush()

    rows = [
        {"fulfillment-channel": "Amazon", "fulfillment channel": "Merchant"},
        {"fulfillment-channel": "Merchant"},
        {"fulfillment channel": "Amazon"},
        {"fulfillment-channel": "Merchant"},
        {},
    ]
    currencies = ["USD", "USD", "USD", "CAD", "CAD"]
    for index, (raw_row, currency) in enumerate(zip(rows, currencies, strict=True), start=1):
        db.add(
            AnalysisSalesOrderRow(
                project_id=project.id,
                source_file_id=source.id,
                source_row_no=index,
                amazon_order_id=f"BLF1266-{uuid.uuid4().hex[:12]}",
                purchase_at_utc=datetime.now(timezone.utc),
                purchase_at_pt=datetime.now(timezone.utc).replace(tzinfo=None),
                purchase_date_pt=today,
                order_status="Shipped",
                country="US",
                sku=f"BLF1266-SKU-{index}",
                asin=f"BLF1266-ASIN-{index}",
                quantity=index,
                item_price=Decimal("10.00"),
                shipping_price=Decimal("1.00"),
                item_tax=Decimal("0.00"),
                shipping_tax=Decimal("0.00"),
                currency=currency,
                is_counted_sales=True,
                raw_row=raw_row,
            )
        )
    db.flush()
    return {"project_id": project.id, "rows": rows}


def test_generated_column_matches_raw_json_coalesce_semantics(db_session: Session) -> None:
    env = _seed_order_rows(db_session)
    rows = db_session.execute(
        select(AnalysisSalesOrderRow.raw_row, AnalysisSalesOrderRow.fulfillment_channel)
        .where(AnalysisSalesOrderRow.project_id == env["project_id"])
        .order_by(AnalysisSalesOrderRow.source_row_no)
    ).all()

    assert len(rows) == len(env["rows"])
    for raw_row, fulfillment_channel in rows:
        expected = raw_row.get("fulfillment-channel") or raw_row.get("fulfillment channel")
        assert fulfillment_channel == expected
    assert rows[0].fulfillment_channel == "Amazon"  # canonical key wins
    assert rows[2].fulfillment_channel == "Amazon"  # legacy key fallback
    assert rows[-1].fulfillment_channel is None


def test_stats_without_project_joins_match_joined_legacy_aggregates(
    db_session: Session,
) -> None:
    env = _seed_order_rows(db_session)
    project_id = env["project_id"]
    channel = AnalysisSalesOrderRow.fulfillment_channel
    optimized = svc.compute_stats(
        db_session,
        project_ids=[project_id],
        fulfillment_channels=["Amazon", "Merchant"],
        order_statuses=["Shipped"],
        countries=["US"],
        operator="pytest",
        is_admin=True,
    )

    # Reference the legacy joined SQL and raw JSON semantics. The FK-backed
    # joins must not alter any of the six public stats fields.
    legacy_from = AnalysisSalesOrderRow.__table__.join(
        AnalysisSourceFile.__table__,
        AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
    ).join(Project.__table__, Project.id == AnalysisSourceFile.project_id)
    fulfillment_expr = func.coalesce(
        AnalysisSalesOrderRow.raw_row["fulfillment-channel"].as_string(),
        AnalysisSalesOrderRow.raw_row["fulfillment channel"].as_string(),
    )
    legacy_aggregate = db_session.execute(
        select(
            func.count(AnalysisSalesOrderRow.id),
            func.coalesce(func.sum(AnalysisSalesOrderRow.quantity), 0),
            func.coalesce(func.sum(sales_amount_expr_by_row()), 0.0),
            func.coalesce(func.sum(case((fulfillment_expr == "Amazon", 1), else_=0)), 0),
            func.coalesce(func.sum(case((fulfillment_expr == "Merchant", 1), else_=0)), 0),
        )
        .select_from(legacy_from)
        .where(
            AnalysisSalesOrderRow.project_id == project_id,
            AnalysisSalesOrderRow.order_status == "Shipped",
            AnalysisSalesOrderRow.country == "US",
            fulfillment_expr.in_(["Amazon", "Merchant"]),
        )
    ).one()
    legacy_currency = db_session.execute(
        select(
            AnalysisSalesOrderRow.currency,
            func.count(AnalysisSalesOrderRow.id).label("count"),
        )
        .select_from(legacy_from)
        .where(
            AnalysisSalesOrderRow.project_id == project_id,
            AnalysisSalesOrderRow.order_status == "Shipped",
            AnalysisSalesOrderRow.country == "US",
            fulfillment_expr.in_(["Amazon", "Merchant"]),
            AnalysisSalesOrderRow.currency.is_not(None),
        )
        .group_by(AnalysisSalesOrderRow.currency)
        .order_by(
            func.count(AnalysisSalesOrderRow.id).desc(),
            AnalysisSalesOrderRow.currency.asc(),
        )
        .limit(1)
    ).first()

    assert optimized.total_orders == legacy_aggregate[0]
    assert optimized.total_quantity == legacy_aggregate[1]
    assert optimized.total_amount == pytest.approx(float(legacy_aggregate[2]), abs=0.01)
    assert optimized.fba_count == legacy_aggregate[3]
    assert optimized.fbm_count == legacy_aggregate[4]
    assert optimized.currency == (legacy_currency.currency if legacy_currency else None)

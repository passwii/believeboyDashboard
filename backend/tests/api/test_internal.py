"""Integration tests for /api/v1/internal/auto-report/* endpoints.

Uses FastAPI TestClient + real Postgres test database.
Each test sets ``INTERNAL_INGEST_TOKEN`` in the env before the app loads.
"""
from __future__ import annotations

import hashlib
import os
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app


@pytest.fixture(scope="module", autouse=True)
def _set_internal_token():
    os.environ["INTERNAL_INGEST_TOKEN"] = "test-internal-token-32-bytes-1234"
    from app.core import config as cfg
    cfg.get_settings.cache_clear()
    yield
    cfg.get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Session:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def auth_headers() -> dict[str, str]:
    return {"X-Internal-Token": "test-internal-token-32-bytes-1234"}


def test_health_no_token_rejected(client):
    """Without a token the endpoints return 401."""
    r = client.post(
        "/api/v1/internal/auto-report/recognize",
        json={
            "folder_name": "博朗姆",
            "original_filename": "test.xlsx",
            "country": "US",
            "report_type": "sales_report",
            "matched_columns": [],
            "row_count_preview": 0,
        },
    )
    assert r.status_code == 401, r.text


def test_health_wrong_token_rejected(client):
    r = client.post(
        "/api/v1/internal/auto-report/recognize",
        json={
            "folder_name": "博朗姆",
            "original_filename": "test.xlsx",
            "country": "US",
            "report_type": "sales_report",
            "matched_columns": [],
            "row_count_preview": 0,
        },
        headers={"X-Internal-Token": "wrong"},
    )
    assert r.status_code == 401, r.text


def test_recognize_unmatched_folder(client, auth_headers):
    """A folder name that doesn't exist in projects → can_ingest=False."""
    r = client.post(
        "/api/v1/internal/auto-report/recognize",
        json={
            "folder_name": "non-existent-project-xyz",
            "original_filename": "test.xlsx",
            "country": "US",
            "report_type": "sales_report",
            "matched_columns": [],
            "row_count_preview": 100,
        },
        headers=auth_headers,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["can_ingest"] is False
    assert body["match_status"] == "unmatched"
    assert body["project_id"] == 0


def test_ingest_duplicate_sha256_returns_duplicate(client, auth_headers, db_session):
    """If a row with the same sha256 already exists, /ingest returns duplicate."""
    from datetime import date, timedelta
    from app.models.product_analysis_source import AnalysisSourceFile
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(b"test-content-1").hexdigest()
    # Pick a far-future date unique to this run (avoid unique constraint collisions
    # when the test is re-run without the seed row being cleaned up).
    import os
    unique_day = date(2098, 1, 1) + timedelta(days=int.from_bytes(os.urandom(2), "big") % 365)
    existing = AnalysisSourceFile(
        project_id=project_id,
        report_type="sales_report",
        country="US",
        report_date=unique_day,
        period_start_date=unique_day,
        period_end_date=unique_day,
        version=1,
        is_current=True,
        upload_file_id="existing",
        upload_file_path="/tmp/existing",
        original_filename="existing.xlsx",
        stored_filename="existing",
        logical_filename="existing",
        storage_key=f"analysis/existing/sales_report/{unique_day.strftime('%Y%m%d')}_{unique_day.strftime('%Y%m%d')}/v1/existing",
        file_size_bytes=100,
        file_sha256=sha,
        ingestion_status="success",
        row_count_total=10,
        row_count_included=10,
    )
    db_session.add(existing)
    db_session.commit()
    seeded_id = existing.id

    try:
        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "sales_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": "test.xlsx",
                "file_sha256": sha,
                "file_size_bytes": 100,
                "local_file_path": "/tmp/test.xlsx",
                "matched_columns": [],
                "warnings": [],
                "report_label": "销售报告",
                "report_date": "2099-01-01",
                "scopes": [
                    {
                        "scope_date": "2099-01-01",
                        "row_count_preview": 5,
                        "scope_rows": [],
                    }
                ],
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "duplicate"
        assert body["duplicate_match_table"] == "A"
        assert body["duplicate_source_id"] == seeded_id
    finally:
        # Clean up: the seed row + any leftover same-sha rows from prior
        # failed runs (dedup has no ORDER BY so a stale row would shadow
        # the fresh seeded_id). Also remove upload log rows this test
        # might have created (smoke-test-* runs and SHA-256 err msgs).
        from sqlalchemy import text
        db_session.execute(text("DELETE FROM auto_report_upload_logs WHERE run_id LIKE 'smoke-test-%' OR error_message LIKE '%SHA-256%'"))
        db_session.execute(text(f"DELETE FROM analysis_source_files WHERE file_sha256 = '{sha}'"))
        db_session.commit()


def _unique_day(label: str) -> "date":
    """Pick a far-future date that won't collide with real data or other tests."""
    import os as _os
    return date(2097, 1, 1) + timedelta(days=int.from_bytes(_os.urandom(2), "big") % 30000) + timedelta(days=hash(label) % 365)


def _cleanup_a_table(db_session, sha: str) -> None:
    """Remove A-table artifacts created by a test ingest."""
    from sqlalchemy import text
    db_session.execute(
        text("DELETE FROM analysis_sales_order_rows WHERE source_file_id IN (SELECT id FROM analysis_source_files WHERE file_sha256 = :s)"),
        {"s": sha},
    )
    db_session.execute(
        text("DELETE FROM analysis_business_rows WHERE source_file_id IN (SELECT id FROM analysis_source_files WHERE file_sha256 = :s)"),
        {"s": sha},
    )
    db_session.execute(
        text("DELETE FROM analysis_payment_rows WHERE source_file_id IN (SELECT id FROM analysis_source_files WHERE file_sha256 = :s)"),
        {"s": sha},
    )
    db_session.execute(
        text("DELETE FROM analysis_return_rows WHERE source_file_id IN (SELECT id FROM analysis_source_files WHERE file_sha256 = :s)"),
        {"s": sha},
    )
    db_session.execute(
        text("DELETE FROM analysis_ad_product_rows WHERE source_file_id IN (SELECT id FROM analysis_source_files WHERE file_sha256 = :s)"),
        {"s": sha},
    )
    db_session.execute(
        text("DELETE FROM report_upload_logs WHERE original_filename LIKE 'test-ingest-a-%'"),
    )
    db_session.execute(text("DELETE FROM analysis_source_files WHERE file_sha256 = :s"), {"s": sha})
    db_session.commit()


def test_ingest_sales_writes_detail_rows(client, auth_headers, db_session, tmp_path):
    """Bug 1: A-table /ingest must write analysis_sales_order_rows from the file.

    The backend now re-reads ``local_file_path`` through the canonical
    ``parse_sales_rows`` helper rather than trusting the daemon's
    ``scope_rows`` field, so this test creates a real on-disk Amazon sales
    TSV with 2 data rows and asserts the bulk insert lands both.
    """
    from app.models.product_analysis_source import AnalysisSalesOrderRow
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(f"sales-detail-test-fixture-{os.urandom(8).hex()}".encode()).hexdigest()
    day = _unique_day("sales-detail")

    # Build a real Amazon sales TSV with 2 data rows so parse_sales_rows
    # can ingest it. The parser is column-name-strict (lowercase
    # 'amazon-order-id', 'purchase-date', etc.).
    filename = f"test-ingest-a-sales-{sha[:8]}.txt"
    file_path = tmp_path / filename
    file_path.write_text(
        "\t".join(
            [
                "amazon-order-id",
                "merchant-order-id",
                "purchase-date",
                "last-updated-date",
                "order-status",
                "fulfillment-channel",
                "sales-channel",
                "sku",
                "asin",
                "quantity",
                "item-price",
                "shipping-price",
                "currency",
            ]
        )
        + "\n"
        + "\t".join(
            [
                "111-0000001-0000001",
                "111-0000001-0000001",
                f"{day.isoformat()}T12:00:00+00:00",
                f"{day.isoformat()}T12:00:01+00:00",
                "Pending",
                "Amazon",
                "Amazon.com",
                "SKU-A",
                "B0TEST00001",
                "1",
                "9.99",
                "0.00",
                "USD",
            ]
        )
        + "\n"
        + "\t".join(
            [
                "111-0000002-0000002",
                "111-0000002-0000002",
                f"{day.isoformat()}T13:00:00+00:00",
                f"{day.isoformat()}T13:00:01+00:00",
                "Shipped",
                "Amazon",
                "Amazon.com",
                "SKU-B",
                "B0TEST00002",
                "2",
                "19.98",
                "0.00",
                "USD",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    try:
        # Pre-parse the file into schema-shaped row dicts — this mirrors
        # what the daemon does before sending scope_rows. The backend now
        # trusts the daemon to translate column names, so the test must
        # too.
        import sys
        sys.path.insert(0, str(file_path.parent.parent.parent / "backend"))
        from app.utils.parsers import parse_sales_rows
        from app.utils.utils import to_raw_row as _to_raw_row
        scope_rows, _, _ = parse_sales_rows(
            file_path, source_file_id=0, country="US",
        )

        # Coerce every value to a JSON-safe type (parse_sales_rows leaves
        # datetime/Decimal objects on the row; the daemon will do the
        # same conversion before posting to /ingest).
        from decimal import Decimal as _Decimal
        def _jsonable(value):
            if hasattr(value, "isoformat"):
                try:
                    return value.isoformat()
                except TypeError:
                    pass
            if isinstance(value, _Decimal):
                return str(value)
            if isinstance(value, dict):
                return {k: _jsonable(v) for k, v in value.items()}
            if isinstance(value, list):
                return [_jsonable(v) for v in value]
            return value
        for row in scope_rows:
            for k, v in list(row.items()):
                row[k] = _jsonable(v)

        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "sales_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": filename,
                "file_sha256": sha,
                "file_size_bytes": file_path.stat().st_size,
                "local_file_path": str(file_path),
                "matched_columns": ["amazon-order-id", "sku", "purchase-date"],
                "warnings": [],
                "report_label": "销售报告",
                "report_date": day.isoformat(),
                "scopes": [
                    {
                        "scope_date": day.isoformat(),
                        "row_count_preview": len(scope_rows),
                        "scope_rows": scope_rows,
                    }
                ],
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "created", body
        source_id = body["source_id"]

        from sqlalchemy import text
        detail_count = db_session.execute(
            text("SELECT count(*) FROM analysis_sales_order_rows WHERE source_file_id = :id"),
            {"id": source_id},
        ).scalar()
        assert detail_count == 2, f"expected 2 detail rows, got {detail_count}"

        # Verify the data actually landed (not just row count) — the parser
        # would have mapped the row dicts into schema fields.
        amount_sum = db_session.execute(
            text(
                "SELECT COALESCE(SUM(item_price), 0) FROM analysis_sales_order_rows "
                "WHERE source_file_id = :id"
            ),
            {"id": source_id},
        ).scalar()
        assert float(amount_sum) == 29.97, f"item_price sum mismatch: {amount_sum}"
    finally:
        _cleanup_a_table(db_session, sha)


def test_ingest_sales_splits_per_purchase_date(client, auth_headers, db_session, tmp_path):
    """Sales reports with rows across multiple ``purchase_date_pt`` values
    must produce one ``analysis_source_files`` row per distinct date.

    The daily-analysis aggregator filters on
    ``AnalysisSourceFile.report_date``; without per-date source rows every
    order in the file would land on whichever date the daemon picked as
    ``scope_date`` (regression: prior refactor used ``detected_start_date``
    as the only scope date, collapsing 3-day sales files into a single
    bucket).
    """
    import sys
    from decimal import Decimal as _Decimal

    from app.models.product_analysis_source import AnalysisSalesOrderRow
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(
        f"sales-per-date-fixture-{os.urandom(8).hex()}".encode()
    ).hexdigest()
    day_a = _unique_day("sales-per-date-a")
    day_b = day_a + timedelta(days=1)

    # Build a 3-row TSV: 2 rows on day_a, 1 row on day_b. We use
    # _unique_day for day_a so it cannot collide with prior runs, and a
    # +1 offset for day_b so the partition actually has two buckets.
    filename = f"test-ingest-a-sales-per-date-{sha[:8]}.txt"
    file_path = tmp_path / filename
    file_path.write_text(
        "\t".join(
            [
                "amazon-order-id",
                "purchase-date",
                "order-status",
                "sku",
                "asin",
                "quantity",
                "item-price",
                "shipping-price",
                "currency",
            ]
        )
        + "\n"
        + "\t".join(
            [
                "111-1000001-0000001",
                f"{day_a.isoformat()}T12:00:00+00:00",
                "Shipped",
                "SKU-A1",
                "B0TEST00001",
                "1",
                "9.99",
                "0.00",
                "USD",
            ]
        )
        + "\n"
        + "\t".join(
            [
                "111-1000002-0000002",
                f"{day_a.isoformat()}T13:00:00+00:00",
                "Pending",
                "SKU-A2",
                "B0TEST00002",
                "2",
                "19.98",
                "0.00",
                "USD",
            ]
        )
        + "\n"
        + "\t".join(
            [
                "111-1000003-0000003",
                f"{day_b.isoformat()}T12:00:00+00:00",
                "Shipped",
                "SKU-B1",
                "B0TEST00003",
                "1",
                "5.99",
                "0.00",
                "USD",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    try:
        # Pre-parse the file the way the daemon does, then split scope_rows
        # by ``purchase_date_pt`` so each bucket becomes its own scope.
        sys.path.insert(0, str(file_path.parent.parent.parent / "backend"))
        from app.utils.parsers import parse_sales_rows

        all_rows, _, _ = parse_sales_rows(
            file_path, source_file_id=0, country="US",
        )

        def _jsonable(value):
            if hasattr(value, "isoformat"):
                try:
                    return value.isoformat()
                except TypeError:
                    pass
            if isinstance(value, _Decimal):
                return str(value)
            if isinstance(value, dict):
                return {k: _jsonable(v) for k, v in value.items()}
            if isinstance(value, list):
                return [_jsonable(v) for v in value]
            return value

        grouped: dict[date, list[dict]] = {}
        for row in all_rows:
            pt = row.get("purchase_date_pt")
            if isinstance(pt, date):
                grouped.setdefault(pt, []).append(row)

        scopes = []
        for scope_date in sorted(grouped):
            day_rows = grouped[scope_date]
            for r in day_rows:
                for k, v in list(r.items()):
                    r[k] = _jsonable(v)
            scopes.append(
                {
                    "scope_date": scope_date.isoformat(),
                    "row_count_preview": len(day_rows),
                    "scope_rows": day_rows,
                }
            )

        assert len(scopes) == 2, f"expected 2 scopes (one per date), got {len(scopes)}"

        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "sales_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": filename,
                "file_sha256": sha,
                "file_size_bytes": file_path.stat().st_size,
                "local_file_path": str(file_path),
                "matched_columns": ["amazon-order-id", "sku", "purchase-date"],
                "warnings": [],
                "report_label": "销售报告",
                "report_date": day_b.isoformat(),
                "scopes": scopes,
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "created", body

        # Two AnalysisSourceFile rows: one per scope_date.
        from sqlalchemy import text

        rows = db_session.execute(
            text(
                "SELECT id, report_date FROM analysis_source_files "
                "WHERE file_sha256 = :s ORDER BY report_date"
            ),
            {"s": sha},
        ).all()
        assert len(rows) == 2, f"expected 2 source rows, got {len(rows)}: {rows}"
        report_dates = {row[1] for row in rows}
        assert report_dates == {day_a, day_b}, (
            f"source rows must own their purchase date, got {report_dates}"
        )

        # Build a date -> source_id map and verify detail rows are
        # partitioned to the right source row.
        date_to_source_id = {row[1]: row[0] for row in rows}

        # day_a should have 2 detail rows; day_b should have 1.
        for scope_date, expected_count in [(day_a, 2), (day_b, 1)]:
            sid = date_to_source_id[scope_date]
            detail_count = db_session.execute(
                text(
                    "SELECT count(*) FROM analysis_sales_order_rows "
                    "WHERE source_file_id = :id"
                ),
                {"id": sid},
            ).scalar()
            assert detail_count == expected_count, (
                f"scope_date={scope_date} source_id={sid}: "
                f"expected {expected_count} detail rows, got {detail_count}"
            )

        # Cross-check: no detail row should be linked to the wrong source.
        # Pick the day_a source id and assert none of its detail rows have
        # purchase_date_pt on day_b (and vice versa).
        from sqlalchemy import text as _text

        for scope_date in (day_a, day_b):
            sid = date_to_source_id[scope_date]
            wrong_count = db_session.execute(
                _text(
                    "SELECT count(*) FROM analysis_sales_order_rows "
                    "WHERE source_file_id = :id AND purchase_date_pt <> :d"
                ),
                {"id": sid, "d": scope_date},
            ).scalar()
            assert wrong_count == 0, (
                f"source_id={sid} (scope_date={scope_date}) has "
                f"{wrong_count} detail rows belonging to a different date"
            )

        # Last-but-not-least: only one row per scope should still be
        # is_current (matches the new source row).
        for scope_date in (day_a, day_b):
            sid = date_to_source_id[scope_date]
            is_current = db_session.execute(
                _text(
                    "SELECT is_current FROM analysis_source_files WHERE id = :id"
                ),
                {"id": sid},
            ).scalar()
            assert is_current is True, (
                f"source_id={sid} (scope_date={scope_date}) must be is_current"
            )
    finally:
        _cleanup_a_table(db_session, sha)


def test_ingest_sales_failure_no_source_row(client, auth_headers, db_session):
    """Fail-loud: refuse to write an empty source file when the daemon
    reports non-zero preview but ships zero ``scope_rows``.

    Regression: 7.2 18:03:36 博朗姆 Orders-2026-07-02_18-03-36.txt went
    through ``parse_sales_rows`` failure → fallback created a source
    row with ``scope_rows=[]`` and 0 detail rows landed. daily-analysis
    silently showed nothing for that file. We now raise 5xx so the
    daemon's API client leaves the file in the watch root and the
    failure is visible in the daemon log + monitoring.
    """
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(
        f"sales-fail-loud-{os.urandom(8).hex()}".encode()
    ).hexdigest()
    day = _unique_day("sales-fail-loud")

    # The exact symptom of the 7.2 bug: preview says 12, but scope_rows
    # is empty. Backend MUST refuse to write the source row.
    try:
        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "sales_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": f"test-fail-loud-{sha[:8]}.txt",
                "file_sha256": sha,
                "file_size_bytes": 4096,
                "local_file_path": f"/tmp/test-fail-loud-{sha[:8]}.txt",
                "matched_columns": ["amazon-order-id", "sku", "purchase-date"],
                "warnings": [],
                "report_label": "销售报告",
                "report_date": day.isoformat(),
                "scopes": [
                    {
                        "scope_date": day.isoformat(),
                        "row_count_preview": 12,
                        "scope_rows": [],
                    }
                ],
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        # Must be 5xx (FastAPI surfaces ValueError as 500).
        assert r.status_code >= 500, (
            f"expected 5xx for empty scope_rows with non-zero preview, "
            f"got {r.status_code}: {r.text}"
        )
        body = r.json()
        detail_text = str(body.get("detail", ""))
        assert "empty scope_rows" in detail_text or "refusing" in detail_text, (
            f"error message should mention 'empty scope_rows' or 'refusing', "
            f"got: {detail_text!r}"
        )

        # DB must be untouched.
        from sqlalchemy import text
        sf_count = db_session.execute(
            text(
                "SELECT count(*) FROM analysis_source_files "
                "WHERE file_sha256 = :s"
            ),
            {"s": sha},
        ).scalar()
        assert sf_count == 0, (
            f"expected 0 source rows for fail-loud, got {sf_count}"
        )
        detail_count = db_session.execute(
            text("SELECT count(*) FROM analysis_sales_order_rows "
                 "WHERE source_file_id IN (SELECT id FROM analysis_source_files "
                 "WHERE file_sha256 = :s)"),
            {"s": sha},
        ).scalar()
        assert detail_count == 0, (
            f"expected 0 detail rows for fail-loud, got {detail_count}"
        )
    finally:
        _cleanup_a_table(db_session, sha)


def test_ingest_stores_basename_not_absolute_path(
    client, auth_headers, db_session, tmp_path
):
    """The A-table ingest path stores only the file basename in
    ``analysis_source_files.upload_file_path``, not the absolute path
    the daemon lives on.

    Rationale: the daemon runs on Mac, the API runs on VPS, and the
    VPS does NOT store report files. Storing the full Mac path
    (e.g. ``/Users/damon/Documents/RPA/博朗姆/processed/Orders-...txt``)
    in a column the backend never reads is a violation of the
    "VPS does not store files" principle. We keep the column (so the
    audit trail still names the file) but reduce it to the basename.
    """
    from app.models.product_analysis_source import AnalysisSalesOrderRow
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(
        f"sales-basename-{os.urandom(8).hex()}".encode()
    ).hexdigest()
    day = _unique_day("sales-basename")

    filename = f"test-basename-{sha[:8]}.txt"
    # Fake a deeply-nested Mac-style absolute path the daemon would
    # send. The basename of this path is the only thing the backend
    # should ever persist.
    mac_style_path = (
        f"/Users/damon/Documents/RPA/博朗姆/processed/{filename}"
    )
    file_path = tmp_path / filename
    file_path.write_text(
        "\t".join(
            [
                "amazon-order-id",
                "purchase-date",
                "order-status",
                "sku",
                "asin",
                "quantity",
                "item-price",
                "shipping-price",
                "currency",
            ]
        )
        + "\n"
        + "\t".join(
            [
                "111-9999001-0000001",
                f"{day.isoformat()}T12:00:00+00:00",
                "Shipped",
                "SKU-BASE",
                "B0TESTBASE1",
                "1",
                "9.99",
                "0.00",
                "USD",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    try:
        import sys
        sys.path.insert(0, str(file_path.parent.parent.parent / "backend"))
        from app.utils.parsers import parse_sales_rows
        scope_rows, _, _ = parse_sales_rows(
            file_path, source_file_id=0, country="US",
        )

        from decimal import Decimal as _Decimal
        def _jsonable(value):
            if hasattr(value, "isoformat"):
                try:
                    return value.isoformat()
                except TypeError:
                    pass
            if isinstance(value, _Decimal):
                return str(value)
            if isinstance(value, dict):
                return {k: _jsonable(v) for k, v in value.items()}
            if isinstance(value, list):
                return [_jsonable(v) for v in value]
            return value

        for r in scope_rows:
            for k, v in list(r.items()):
                r[k] = _jsonable(v)

        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "sales_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": filename,
                "file_sha256": sha,
                "file_size_bytes": file_path.stat().st_size,
                "local_file_path": mac_style_path,
                "matched_columns": ["amazon-order-id", "sku", "purchase-date"],
                "warnings": [],
                "report_label": "销售报告",
                "report_date": day.isoformat(),
                "scopes": [
                    {
                        "scope_date": day.isoformat(),
                        "row_count_preview": len(scope_rows),
                        "scope_rows": scope_rows,
                    }
                ],
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "created", body
        source_id = body["source_id"]

        # The source row must store ONLY the basename, not the full
        # Mac path. Anything else violates the "VPS does not store
        # files" principle.
        from sqlalchemy import text
        stored_path = db_session.execute(
            text("SELECT upload_file_path FROM analysis_source_files WHERE id = :id"),
            {"id": source_id},
        ).scalar()
        assert stored_path == filename, (
            f"upload_file_path must be basename only; "
            f"expected {filename!r}, got {stored_path!r}"
        )
        # Belt and suspenders: no directory separators survived.
        assert "/" not in stored_path, (
            f"upload_file_path must not contain '/': {stored_path!r}"
        )
    finally:
        _cleanup_a_table(db_session, sha)


def test_ingest_ad_target_writes_detail_rows(client, auth_headers, db_session):
    """Bug 2: C-table /ingest must write ad_upload_target_rows from scope_rows.

    The current implementation calls save_ad_upload_scope, but the daemon
    only sends scope_rows for multi-day ad reports — single-day ad reports
    ship scope_rows=[]. This test feeds non-empty scope_rows (with the
    Chinese column names the canonical helper expects) and asserts the
    detail table receives them.
    """
    from app.models.ad_upload import AdUploadFile, AdUploadTargetRow
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(f"ad-target-detail-test-fixture-{os.urandom(8).hex()}".encode()).hexdigest()
    day = _unique_day("ad-target-detail")

    # Real ad_target_report row format the canonical helper consumes:
    #   开始日期 / 结束日期 / 投放 / 匹配类型 / 展示量 / 点击量 / 花费 / 7天总销售额 ...
    row1 = {
        "开始日期": day.isoformat(),
        "结束日期": day.isoformat(),
        "广告活动名称": "Test Campaign A",
        "投放": "keyword-A",
        "匹配类型": "广泛匹配",
        "展示量": 100,
        "点击量": 5,
        "花费": "1.50",
        "7天总销售额": "9.99",
        "7天总订单数(#)": 1,
    }
    row2 = {
        "开始日期": day.isoformat(),
        "结束日期": day.isoformat(),
        "广告活动名称": "Test Campaign B",
        "投放": "keyword-B",
        "匹配类型": "精准匹配",
        "展示量": 200,
        "点击量": 10,
        "花费": "3.00",
        "7天总销售额": "19.98",
        "7天总订单数(#)": 2,
    }

    try:
        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "ad_target_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": f"test-ingest-c-target-{sha[:8]}.xlsx",
                "file_sha256": sha,
                "file_size_bytes": 2048,
                "local_file_path": f"/tmp/test-ingest-c-target-{sha[:8]}.xlsx",
                "matched_columns": ["开始日期", "结束日期", "广告活动名称", "投放", "匹配类型"],
                "warnings": [],
                "report_label": "广告投放报告",
                "report_date": day.isoformat(),
                "scopes": [
                    {
                        "scope_date": day.isoformat(),
                        "row_count_preview": 2,
                        "scope_rows": [row1, row2],
                    }
                ],
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "created", body
        source_id = body["source_id"]

        from sqlalchemy import text
        detail_count = db_session.execute(
            text("SELECT count(*) FROM ad_upload_target_rows WHERE source_file_id = :id"),
            {"id": source_id},
        ).scalar()
        assert detail_count == 2, f"expected 2 detail rows, got {detail_count}"
    finally:
        from sqlalchemy import text
        db_session.execute(
            text("DELETE FROM ad_upload_target_rows WHERE source_file_id IN (SELECT id FROM ad_upload_files WHERE file_sha256 = :s)"),
            {"s": sha},
        )
        db_session.execute(
            text("DELETE FROM ad_upload_files WHERE file_sha256 = :s"),
            {"s": sha},
        )
        db_session.commit()


def test_ingest_ad_target_writes_upload_log(client, auth_headers, db_session):
    """Bug 3: C-table /ingest must write a row to report_upload_logs.

    Currently report_upload_logs is only written for A-table reports; the
    C-table branch skips the write entirely, so the RPA status grid never
    flips green for ad reports. This test asserts one row appears.
    """
    from app.models.project import Project
    from app.models.ad_upload import AdUploadFile

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    sha = hashlib.sha256(f"ad-target-upload-log-test-fixture-{os.urandom(8).hex()}".encode()).hexdigest()
    day = _unique_day("ad-target-upload-log")
    original_filename = f"test-ingest-c-target-log-{sha[:8]}.xlsx"

    row = {
        "开始日期": day.isoformat(),
        "结束日期": day.isoformat(),
        "广告活动名称": "Upload Log Test",
        "投放": "kw1",
        "匹配类型": "广泛匹配",
        "展示量": 10,
        "点击量": 1,
        "花费": "0.10",
        "7天总销售额": "0.00",
        "7天总订单数(#)": 0,
    }

    try:
        r = client.post(
            "/api/v1/internal/auto-report/ingest",
            json={
                "report_type": "ad_target_report",
                "project_id": project_id,
                "country": "US",
                "original_filename": original_filename,
                "file_sha256": sha,
                "file_size_bytes": 1024,
                "local_file_path": f"/tmp/{original_filename}",
                "matched_columns": ["开始日期", "结束日期", "广告活动名称", "投放", "匹配类型"],
                "warnings": [],
                "report_label": "广告投放报告",
                "report_date": day.isoformat(),
                "scopes": [
                    {
                        "scope_date": day.isoformat(),
                        "row_count_preview": 1,
                        "scope_rows": [row],
                    }
                ],
                "operator": "autoReportUpload",
            },
            headers=auth_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "created", body

        from app.models.report_upload_log import ReportUploadLog
        from sqlalchemy import text
        log_count = db_session.execute(
            text(
                "SELECT count(*) FROM report_upload_logs "
                "WHERE original_filename = :f AND report_type = 'ad_target_report'"
            ),
            {"f": original_filename},
        ).scalar()
        assert log_count >= 1, f"expected at least 1 upload log row, got {log_count}"
    finally:
        from sqlalchemy import text
        db_session.execute(
            text("DELETE FROM report_upload_logs WHERE original_filename = :f"),
            {"f": original_filename},
        )
        db_session.execute(
            text("DELETE FROM ad_upload_target_rows WHERE source_file_id IN (SELECT id FROM ad_upload_files WHERE file_sha256 = :s)"),
            {"s": sha},
        )
        db_session.execute(
            text("DELETE FROM ad_upload_files WHERE file_sha256 = :s"),
            {"s": sha},
        )
        db_session.commit()
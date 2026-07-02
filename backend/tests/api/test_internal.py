"""Integration tests for /api/v1/internal/auto-report/* endpoints.

Uses FastAPI TestClient + real Postgres test database.
Each test sets ``INTERNAL_INGEST_TOKEN`` in the env before the app loads.
"""
from __future__ import annotations

import hashlib
import os
from datetime import date

import pytest
from fastapi.testclient import TestClient
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
    from app.models.product_analysis_source import AnalysisSourceFile
    from app.models.project import Project

    project = db_session.query(Project).first()
    if project is None:
        pytest.skip("no project in test db, seed first")
    project_id = project.id

    # Pick a unique period per run to avoid colliding with rows left by
    # prior runs. The existing DB has 19 projects; a far-future date still
    # collides after a failed first run. Derive both the sha and the day
    # from os.urandom so reruns land on a fresh slot.
    nonce = os.urandom(8)
    sha = hashlib.sha256(b"test-content-1" + nonce).hexdigest()
    day = (int(sha[:2], 16) % 28) + 1  # 1..28
    period = date(2098, 1, day)
    existing = AnalysisSourceFile(
        project_id=project_id,
        report_type="sales_report",
        country="US",
        report_date=period,
        period_start_date=period,
        period_end_date=period,
        version=1,
        is_current=True,
        upload_file_id="existing",
        upload_file_path="/tmp/existing",
        original_filename="existing.xlsx",
        stored_filename="existing",
        logical_filename="existing",
        storage_key=f"analysis/existing/sales_report/{period.strftime('%Y%m%d')}_{period.strftime('%Y%m%d')}/v1/existing",
        file_size_bytes=100,
        file_sha256=sha,
        ingestion_status="success",
        row_count_total=10,
        row_count_included=10,
    )
    db_session.add(existing)
    db_session.commit()

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
    assert body["duplicate_source_id"] == existing.id
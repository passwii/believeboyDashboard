"""Tests for the settlement transaction CSV download / re-upload endpoints.

Covers:
- admin (is_admin) can download the CSV when present in R2;
- 404 when the CSV is missing from R2;
- 403 when a non-admin operator does not own the project (X-Operator scoping);
- csv-upload updates transaction_file_id and is also operator-scoped (403 for non-owner).

Runs against the real Postgres test database. R2 access is mocked.
"""
from __future__ import annotations

import io
import uuid
from contextlib import contextmanager
from urllib.parse import quote as url_quote_header
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app
from app.models import MonthlyReport, Project
from app.core.config import get_settings
from app.services.reconciliation_service import get_available_reports


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


def _make_project(db: Session, operator: str) -> Project:
    project = Project(
        project_name=f"测试项目-{operator}-{uuid.uuid4().hex[:8]}",
        project_operator=operator,
        assistant_operator=None,
        is_active=True,
        sort_order=0,
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


def _make_report(db: Session, project: Project, transaction_file_id: str) -> MonthlyReport:
    report = MonthlyReport(
        project_id=project.id,
        project_name=project.project_name,
        country="US",
        report_month="2026-01",
        version=1,
        is_current=True,
        transaction_file_id=transaction_file_id,
        transaction_file_path="/tmp/cache.csv",
        status="success",
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    return report


@contextmanager
def _fake_csv_in_r2(content: bytes = b"col1,col2\n1,2\n"):
    tmp = Path(__file__).parent / f"_tmp_csv_{id(content)}.csv"
    tmp.write_bytes(content)
    try:
        yield tmp
    finally:
        tmp.unlink(missing_ok=True)


@pytest.fixture(autouse=True)
def _patch_artifact(monkeypatch):
    """Control R2 presence without touching real cloud storage."""

    state = {"exists": True}

    def fake_check_exists(key, settings=None):
        return state["exists"]

    @contextmanager
    def fake_download_to_temp(key, suffix=".csv", settings=None):
        with _fake_csv_in_r2() as p:
            yield p

    monkeypatch.setattr(
        "app.services.artifact_service.ArtifactService.check_exists", fake_check_exists
    )
    monkeypatch.setattr(
        "app.services.artifact_service.ArtifactService.download_to_temp",
        fake_download_to_temp,
    )
    return state


def _api_key() -> str:
    return get_settings().api_key


def test_download_csv_admin_success(client, db_session, _patch_artifact):
    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "r2/key/csv.csv")
    _patch_artifact["exists"] = True

    r = client.get(
        f"/api/v1/report-reconciliation/reports/{report.id}/download-csv",
        headers={"X-API-Key": _api_key(), "X-Is-Admin": "true"},
    )
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    assert "filename*=UTF-8" in r.headers["content-disposition"]
    assert r.content == b"col1,col2\n1,2\n"

    _cleanup(db_session, report, project)


def test_download_csv_missing_from_r2(client, db_session, _patch_artifact):
    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "r2/key/missing.csv")
    # CSV key is set but R2 says it's gone
    _patch_artifact["exists"] = False

    r = client.get(
        f"/api/v1/report-reconciliation/reports/{report.id}/download-csv",
        headers={"X-API-Key": _api_key(), "X-Is-Admin": "true"},
    )
    assert r.status_code == 404, r.text
    assert "missing" in r.text.lower()

    _cleanup(db_session, report, project)


def test_download_csv_forbidden_for_non_owner(client, db_session, _patch_artifact):
    # Report belongs to project owned by 李四; requester is 张三 (non-admin).
    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "r2/key/csv.csv")
    _patch_artifact["exists"] = True

    r = client.get(
        f"/api/v1/report-reconciliation/reports/{report.id}/download-csv",
        headers={"X-API-Key": _api_key(), "X-Operator": url_quote_header("张三")},
    )
    assert r.status_code == 403, r.text

    _cleanup(db_session, report, project)


def test_download_csv_not_found_report(client, db_session):
    r = client.get(
        "/api/v1/report-reconciliation/reports/99999999/download-csv",
        headers={"X-API-Key": _api_key(), "X-Is-Admin": "true"},
    )
    assert r.status_code == 404


def test_available_reports_resolves_legacy_bare_filename_csv(db_session, monkeypatch):
    """Legacy monthly-report uploads stored only the bare filename in
    transaction_file_id (e.g. "a1b2c3_transaction.csv"); the real R2 key is
    "{project_slug}/payment-report/{filename}". get_available_reports must
    resolve it instead of surfacing as 'missing'."""
    from app.services.upload_service import _safe_project_folder_name

    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "a1b2c3_transaction.csv")

    expected_key = (
        f"{_safe_project_folder_name(project.project_name)}/payment-report/a1b2c3_transaction.csv"
    )

    def fake_check_exists(key, settings=None):
        # The stored (bare) value is NOT a valid key; the reconstructed
        # legacy key is.
        return key == expected_key

    monkeypatch.setattr(
        "app.services.artifact_service.ArtifactService.check_exists",
        fake_check_exists,
    )

    rows = get_available_reports(db_session, project_id=project.id)
    assert len(rows) == 1
    row = rows[0]
    assert row["has_transaction_csv"] is True
    assert row["transaction_csv_missing"] is False

    _cleanup(db_session, report, project)


def test_download_csv_resolves_legacy_bare_filename(client, db_session, monkeypatch):
    """download-csv must also resolve a legacy bare filename to the real R2 key."""
    from app.services.upload_service import _safe_project_folder_name

    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "a1b2c3_transaction.csv")
    expected_key = (
        f"{_safe_project_folder_name(project.project_name)}/payment-report/a1b2c3_transaction.csv"
    )

    def fake_check_exists(key, settings=None):
        return key == expected_key

    monkeypatch.setattr(
        "app.services.artifact_service.ArtifactService.check_exists",
        fake_check_exists,
    )

    r = client.get(
        f"/api/v1/report-reconciliation/reports/{report.id}/download-csv",
        headers={"X-API-Key": _api_key(), "X-Is-Admin": "true"},
    )
    assert r.status_code == 200, r.text
    assert r.content == b"col1,col2\n1,2\n"

    _cleanup(db_session, report, project)


def test_csv_upload_admin_success(client, db_session, monkeypatch):
    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "r2/old.csv")

    def fake_save_upload_file(file, settings, project_name, file_type):
        return {
            "r2_key": "r2/new/transaction.csv",
            "r2_url": "https://r2/new/transaction.csv",
            "original_filename": file.filename,
            "size": 10,
            "local_path": "/tmp/new.csv",
        }

    monkeypatch.setattr(
        "app.api.v1.endpoints.report_reconciliation.save_upload_file",
        fake_save_upload_file,
    )

    import io

    files = {"csv_file": ("tx.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv")}
    r = client.post(
        f"/api/v1/report-reconciliation/reports/{report.id}/csv-upload",
        files=files,
        headers={"X-API-Key": _api_key(), "X-Is-Admin": "true"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["csv_file_id"] == "r2/new/transaction.csv"

    # Refresh and verify DB was updated
    db_session.expire_all()
    updated = db_session.get(MonthlyReport, report.id)
    assert updated.transaction_file_id == "r2/new/transaction.csv"

    _cleanup(db_session, report, project)


def test_csv_upload_forbidden_for_non_owner(client, db_session, monkeypatch):
    project = _make_project(db_session, "李四")
    report = _make_report(db_session, project, "r2/old.csv")

    def fake_save_upload_file(file, settings, project_name, file_type):
        return {
            "r2_key": "r2/new/transaction.csv",
            "r2_url": "https://r2/new/transaction.csv",
            "original_filename": file.filename,
            "size": 10,
            "local_path": "/tmp/new.csv",
        }

    monkeypatch.setattr(
        "app.api.v1.endpoints.report_reconciliation.save_upload_file",
        fake_save_upload_file,
    )

    import io

    files = {"csv_file": ("tx.csv", io.BytesIO(b"a,b\n1,2\n"), "text/csv")}
    r = client.post(
        f"/api/v1/report-reconciliation/reports/{report.id}/csv-upload",
        files=files,
        headers={"X-API-Key": _api_key(), "X-Operator": url_quote_header("张三")},
    )
    assert r.status_code == 403, r.text

    _cleanup(db_session, report, project)


def _cleanup(db_session: Session, report: MonthlyReport, project: Project) -> None:
    """Delete the created rows; tolerate already-removed rows."""
    db_session.execute(
        __import__("sqlalchemy").delete(MonthlyReport).where(MonthlyReport.id == report.id)
    )
    db_session.execute(
        __import__("sqlalchemy").delete(Project).where(Project.id == project.id)
    )
    db_session.commit()

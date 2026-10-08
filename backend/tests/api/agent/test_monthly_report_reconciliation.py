"""Agent 月报对账端点测试（BLF-1275）。"""

from __future__ import annotations

from contextlib import contextmanager
from decimal import Decimal
from io import BytesIO

import pytest
from app.db.session import SessionLocal
from app.main import app
from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    ReconciliationRecord,
)
from app.models.job import JobStatus
from fastapi.testclient import TestClient
from openpyxl import Workbook
from sqlalchemy import func, select


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _seed_reconciliation_report(
    env, *, with_pt3: bool = True, with_pdf: bool = True
) -> int:
    db = SessionLocal()
    try:
        version = db.execute(
            select(func.max(MonthlyReport.version)).where(
                MonthlyReport.project_id == env["project_id"],
                MonthlyReport.country == "US",
                MonthlyReport.report_month == "2026-10",
            )
        ).scalar_one_or_none()
        report = MonthlyReport(
            project_id=env["project_id"],
            project_name=env["project_name"],
            country="US",
            report_month="2026-10",
            version=(version or 0) + 1,
            is_current=False,
            transaction_file_id="reconciliation-transactions",
            transaction_file_path="private-input.csv",
            status=JobStatus.success,
            summary_pdf_r2_key="private/report.pdf" if with_pdf else None,
        )
        db.add(report)
        db.flush()
        if with_pt3:
            db.add(
                MonthlyReportPT3Calculation(
                    report_id=report.id,
                    project_name=env["project_name"],
                    report_month="2026-10",
                    income_total=12.34,
                    expense_total=-1.23,
                    income_fba_product_sales=12.34,
                )
            )
        db.commit()
        return report.id
    finally:
        db.close()


def _xlsx_bytes() -> bytes:
    workbook = Workbook()
    workbook.active.title = "报表核算"
    output = BytesIO()
    workbook.save(output)
    workbook.close()
    return output.getvalue()


def _result(*, match_rate: float = 100.0) -> dict:
    return {
        "summary": {"excel_total_income": 10.0, "pdf_total_income": 10.0},
        "total_items": 1,
        "matched_items": 1 if match_rate == 100 else 0,
        "mismatched_items": 0 if match_rate == 100 else 1,
        "missing_items": 0,
        "match_rate": match_rate,
        "items": [
            {
                "field_name": "total_income",
                "excel_value": 10.0,
                "pdf_value": 10.0,
                "match": match_rate == 100,
                "difference": 0.0,
                "difference_percent": 0.0,
                "note": None,
            }
        ],
    }


def _add_record(db, report_id: int, mode: str, *, value: float) -> None:
    db.add(
        ReconciliationRecord(
            report_id=report_id,
            operator="test",
            mode=mode,
            match_rate=Decimal("100.0"),
            matched_items=1,
            mismatched_items=0,
            missing_items=0,
            detail_json={
                "summary": {"value": value},
                "items": [{"field_name": "amount", "match": True, "value": value}],
            },
        )
    )


def test_agent_auto_reconciliation_saves_and_upserts_without_realert(
    client, monthly_report_env, monkeypatch
):
    report_id = _seed_reconciliation_report(monthly_report_env)
    from app.services import reconciliation_service

    pdf_path = monthly_report_env["tmp_path"] / "source.pdf"
    pdf_path.write_bytes(b"%PDF-1.7")

    @contextmanager
    def fake_download(_key, *, suffix):
        assert suffix == ".pdf"
        yield pdf_path

    class FakePDFExtractor:
        def __init__(self, _path, *, country):
            assert country == "US"

        def get_raw_data(self):
            return {
                "key_values": {
                    "FBA_product_sales": 12.34,
                    "FBA_product_sale_refunds": 0,
                    "total_income": 100.0,
                    "FBA_selling_fees": 0,
                    "FBA_transaction_fees": 0,
                    "FBA_inventory_and_inbound_services": 0,
                    "service_fees": 0,
                    "advertising_costs": 0,
                    "total_expense": -1.23,
                }
            }

    alerts = []
    monkeypatch.setattr(
        reconciliation_service.ArtifactService, "download_to_temp", fake_download
    )
    monkeypatch.setattr(reconciliation_service, "PDFExtractor", FakePDFExtractor)
    monkeypatch.setattr(
        reconciliation_service,
        "trigger_reconciliation_alert",
        lambda **kwargs: alerts.append(kwargs),
    )
    url = f"/api/v1/agent/monthly-reports/{report_id}/reconciliation/auto"
    first = client.post(url, headers=monthly_report_env["headers"])
    second = client.post(url, headers=monthly_report_env["headers"])

    assert first.status_code == 200, first.text
    assert first.json()["data"]["record_id"] > 0
    assert second.status_code == 200, second.text
    assert second.json()["data"]["record_id"] == first.json()["data"]["record_id"]
    assert first.json()["data"]["match_rate"] < 100
    assert len(alerts) == 1
    db = SessionLocal()
    try:
        records = (
            db.execute(
                select(ReconciliationRecord).where(
                    ReconciliationRecord.report_id == report_id,
                    ReconciliationRecord.mode == "auto",
                )
            )
            .scalars()
            .all()
        )
        assert len(records) == 1
    finally:
        db.close()


def test_auto_reconciliation_rejects_missing_pdf_pt3_and_hides_service_errors(
    client, monthly_report_env, monkeypatch
):
    no_pdf = _seed_reconciliation_report(monthly_report_env, with_pdf=False)
    no_pt3 = _seed_reconciliation_report(monthly_report_env, with_pt3=False)
    base = "/api/v1/agent/monthly-reports"
    headers = monthly_report_env["headers"]

    response = client.post(f"{base}/{no_pdf}/reconciliation/auto", headers=headers)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "MONTHLY_REPORT_NOT_READY"

    response = client.post(f"{base}/{no_pt3}/reconciliation/auto", headers=headers)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "MONTHLY_REPORT_NOT_READY"

    from app.api.v1.endpoints.agent import monthly_reports as endpoint

    def fail(*args, **kwargs):
        raise ValueError("private R2 key and storage path")

    monkeypatch.setattr(endpoint, "auto_reconcile", fail)
    service_error_report = _seed_reconciliation_report(monthly_report_env)
    response = client.post(
        f"{base}/{service_error_report}/reconciliation/auto", headers=headers
    )
    assert response.status_code == 409
    assert "private R2 key" not in response.text
    assert str(monthly_report_env["tmp_path"]) not in response.text


def test_manual_reconciliation_saves_record_and_cleans_private_temp_files(
    client, monthly_report_env, monkeypatch
):
    report_id = _seed_reconciliation_report(monthly_report_env)
    from app.api.v1.endpoints.agent import monthly_reports as endpoint

    monkeypatch.setattr(
        endpoint, "reconcile_to_dict", lambda *args, **kwargs: _result()
    )
    url = f"/api/v1/agent/monthly-reports/{report_id}/reconciliation/manual"
    files = {
        "excel_file": (
            "report.xlsx",
            _xlsx_bytes(),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ),
        "pdf_file": ("summary.pdf", b"%PDF-1.7\nfixture", "application/pdf"),
    }
    response = client.post(url, headers=monthly_report_env["headers"], files=files)

    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert payload["record_id"] > 0
    assert payload["match_rate"] == 100
    replay = client.post(url, headers=monthly_report_env["headers"], files=files)
    assert replay.status_code == 200, replay.text
    assert replay.json()["data"]["record_id"] == payload["record_id"]
    db = SessionLocal()
    try:
        record = db.execute(
            select(ReconciliationRecord).where(
                ReconciliationRecord.report_id == report_id,
                ReconciliationRecord.mode == "manual",
            )
        ).scalar_one()
        assert record.id == payload["record_id"]
        assert record.detail_json["items"][0]["field_name"] == "total_income"
        records = (
            db.execute(
                select(ReconciliationRecord).where(
                    ReconciliationRecord.report_id == report_id,
                    ReconciliationRecord.mode == "manual",
                )
            )
            .scalars()
            .all()
        )
        assert len(records) == 1
    finally:
        db.close()
    assert not list(
        (
            monthly_report_env["settings"].agent_monthly_report_root
            / "reconciliation-tmp"
        ).glob("*")
    )
    assert str(monthly_report_env["tmp_path"]) not in response.text


def test_manual_reconciliation_rejects_invalid_empty_and_oversized_uploads(
    client, monthly_report_env, monkeypatch
):
    report_id = _seed_reconciliation_report(monthly_report_env)
    url = f"/api/v1/agent/monthly-reports/{report_id}/reconciliation/manual"
    headers = monthly_report_env["headers"]

    wrong_type = client.post(
        url,
        headers=headers,
        files={
            "excel_file": ("report.csv", b"nope", "text/csv"),
            "pdf_file": ("summary.pdf", b"%PDF-1.7", "application/pdf"),
        },
    )
    assert wrong_type.status_code == 400
    assert wrong_type.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"

    empty = client.post(
        url,
        headers=headers,
        files={
            "excel_file": ("report.xlsx", b"", "application/octet-stream"),
            "pdf_file": ("summary.pdf", b"%PDF-1.7", "application/pdf"),
        },
    )
    assert empty.status_code == 400
    assert empty.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"

    settings = monthly_report_env["settings"]
    monkeypatch.setattr(settings, "agent_monthly_report_max_bytes", 32)
    too_large = client.post(
        url,
        headers=headers,
        files={
            "excel_file": ("report.xlsx", b"x" * 33, "application/octet-stream"),
            "pdf_file": ("summary.pdf", b"%PDF-1.7", "application/pdf"),
        },
    )
    assert too_large.status_code == 413
    assert too_large.json()["error"]["code"] == "MONTHLY_REPORT_TOO_LARGE"
    assert not list(
        (settings.agent_monthly_report_root / "reconciliation-tmp").glob("*")
    )


def test_reconciliation_history_is_report_filtered_paginated_and_scoped(
    client, monthly_report_env, tmp_path, make_api_key
):
    report_id = _seed_reconciliation_report(monthly_report_env)
    other_report_id = _seed_reconciliation_report(monthly_report_env)
    db = SessionLocal()
    try:
        _add_record(db, report_id, "auto", value=1)
        _add_record(db, report_id, "manual", value=2)
        _add_record(db, other_report_id, "auto", value=3)
        db.commit()
    finally:
        db.close()

    url = f"/api/v1/agent/monthly-reports/{report_id}/reconciliation"
    first = client.get(url + "?limit=1&offset=0", headers=monthly_report_env["headers"])
    assert first.status_code == 200, first.text
    assert first.json()["data"]["total"] == 2
    assert len(first.json()["data"]["records"]) == 1
    assert first.json()["data"]["records"][0]["summary"] == {"value": 2}
    second = client.get(
        url + "?limit=1&offset=1", headers=monthly_report_env["headers"]
    )
    assert second.status_code == 200, second.text
    assert len(second.json()["data"]["records"]) == 1
    assert second.json()["data"]["records"][0]["report_id"] == report_id

    denied = make_api_key(
        agent_id="monthly-reconcile-out-of-scope",
        business_scope="monthly_reports",
        project_scope="99999999",
    )
    denied_headers = {
        "Authorization": f"Bearer {denied['plaintext']}",
        "X-Agent-Id": denied["agent_id"],
    }
    auto_denied = client.post(
        f"/api/v1/agent/monthly-reports/{report_id}/reconciliation/auto",
        headers=denied_headers,
    )
    assert auto_denied.status_code == 404
    assert auto_denied.json()["error"]["code"] == "RESOURCE_NOT_FOUND"
    manual_denied = client.post(
        f"/api/v1/agent/monthly-reports/{report_id}/reconciliation/manual",
        headers=denied_headers,
        files={
            "excel_file": (
                "report.xlsx",
                _xlsx_bytes(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            "pdf_file": ("summary.pdf", b"%PDF-1.7\\nfixture", "application/pdf"),
        },
    )
    assert manual_denied.status_code == 404
    assert manual_denied.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    forbidden = client.get(url, headers=denied_headers)
    assert forbidden.status_code == 404
    assert forbidden.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    missing = client.get(
        "/api/v1/agent/monthly-reports/999999999/reconciliation",
        headers=monthly_report_env["headers"],
    )
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_manual_reconciliation_maps_parser_errors_to_agent_shell(
    client, monthly_report_env, monkeypatch
):
    report_id = _seed_reconciliation_report(monthly_report_env)
    from app.api.v1.endpoints.agent import monthly_reports as endpoint

    def fail(*args, **kwargs):
        raise ValueError("secret local path")

    monkeypatch.setattr(endpoint, "reconcile_to_dict", fail)
    response = client.post(
        f"/api/v1/agent/monthly-reports/{report_id}/reconciliation/manual",
        headers=monthly_report_env["headers"],
        files={
            "excel_file": ("report.xlsx", _xlsx_bytes(), "application/octet-stream"),
            "pdf_file": ("summary.pdf", b"%PDF-1.7\nfixture", "application/pdf"),
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"
    assert "secret local path" not in response.text

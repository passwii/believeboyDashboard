"""Agent 月报读取与导出端点测试（BLF-1251）。"""

from __future__ import annotations

from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.db.session import SessionLocal
from app.main import app
from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
)
from app.models.agent_api_key import AgentApiKey
from app.models.job import JobStatus

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": key["agent_id"],
    }


def _seed_report(env, tmp_path, *, version: int = 1, is_current: bool = True) -> int:
    result_path = tmp_path / f"monthly-report-v{version}.xlsx"
    workbook = load_workbook(BytesIO(_empty_workbook_bytes()))
    workbook.save(result_path)

    db = SessionLocal()
    try:
        report = MonthlyReport(
            project_id=env["project_id"],
            project_name=env["project_name"],
            country="US",
            report_month="2026-10",
            version=version,
            is_current=is_current,
            transaction_file_id=f"transactions-{version}",
            transaction_file_path=str(tmp_path / "transactions.csv"),
            result_file_path=str(result_path),
            status=JobStatus.success,
            total_transactions=3,
            total_orders=2,
            total_refunds=1,
        )
        db.add(report)
        db.flush()
        db.add(
            MonthlyReportPT3Calculation(
                report_id=report.id,
                project_name=env["project_name"],
                report_month="2026-10",
                income_product_sales_non_fba=123.45,
                income_total=123.45,
                income_vat_total=0,
                income_sales_with_tax=123.45,
            )
        )
        db.add(
            MonthlyReportPT4Calculation(
                report_id=report.id,
                project_name=env["project_name"],
                report_month="2026-10",
                income_sales=123.45,
                income_total=123.45,
                expense_total=-3.57,
                amazon_pay_back=119.88,
            )
        )
        db.commit()
        return report.id
    finally:
        db.close()


def _empty_workbook_bytes() -> bytes:
    from openpyxl import Workbook

    workbook = Workbook()
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_monthly_report_list_hides_storage_path_and_supports_history(
    client, monthly_report_env, tmp_path
):
    old_id = _seed_report(monthly_report_env, tmp_path, version=1, is_current=False)
    current_id = _seed_report(monthly_report_env, tmp_path, version=2)

    current = client.get(
        "/api/v1/agent/monthly-reports?project_id="
        f"{monthly_report_env['project_id']}&country=us&month=2026-10",
        headers=monthly_report_env["headers"],
    )
    assert current.status_code == 200, current.text
    current_data = current.json()["data"]
    assert [item["id"] for item in current_data] == [current_id]
    assert current_data[0]["version"] == 2
    assert current_data[0]["result_file_path"] is None
    assert current_data[0]["error_message"] is None
    assert str(tmp_path) not in current.text

    history = client.get(
        "/api/v1/agent/monthly-reports?project_id="
        f"{monthly_report_env['project_id']}&include_history=true",
        headers=monthly_report_env["headers"],
    )
    assert history.status_code == 200, history.text
    assert {item["id"] for item in history.json()["data"]} == {old_id, current_id}


def test_monthly_report_detail_matches_dashboard_fields_without_private_path(
    client, monthly_report_env, tmp_path
):
    report_id = _seed_report(monthly_report_env, tmp_path)

    response = client.get(
        f"/api/v1/agent/monthly-reports/{report_id}",
        headers=monthly_report_env["headers"],
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["report"]["id"] == report_id
    assert data["report"]["total_transactions"] == 3
    assert data["pt3"]["income_product_sales_non_fba"] == 123.45
    assert data["pt4"]["income_total"] == 123.45
    assert data["report"]["result_file_path"] is None
    assert data["report"]["error_message"] is None
    assert str(tmp_path) not in response.text


def test_monthly_financial_series_and_accounting_detail_reuse_dashboard_services(
    client, monthly_report_env, tmp_path
):
    _seed_report(monthly_report_env, tmp_path)
    project_id = monthly_report_env["project_id"]

    series = client.get(
        f"/api/v1/agent/monthly-reports/financial-series?project_id={project_id}"
        "&country=US&start_month=2026-10&end_month=2026-10",
        headers=monthly_report_env["headers"],
    )
    assert series.status_code == 200, series.text
    series_data = series.json()["data"]
    assert series_data["project_id"] == project_id
    assert series_data["rows"][0]["report_month"] == "2026-10"
    assert series_data["rows"][0]["income_total"] == 123.45
    assert series_data["trend"]["points"][0]["income_total"] == 123.45

    detail = client.get(
        "/api/v1/agent/monthly-reports/financial-series/accounting-detail"
        f"?project_id={project_id}&country=US&report_month=2026-10",
        headers=monthly_report_env["headers"],
    )
    assert detail.status_code == 200, detail.text
    detail_data = detail.json()["data"]
    assert detail_data["report_month"] == "2026-10"
    assert detail_data["rows"]
    assert detail_data["rows"][-1]["kind"] == "total"


def test_monthly_report_result_download_is_binary_and_scoped(
    client, monthly_report_env, tmp_path
):
    report_id = _seed_report(monthly_report_env, tmp_path)
    response = client.get(
        f"/api/v1/agent/monthly-reports/{report_id}/export",
        headers=monthly_report_env["headers"],
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(XLSX_MEDIA_TYPE)
    assert response.content[:2] == b"PK"
    assert response.headers["content-disposition"].startswith("attachment;")
    workbook = load_workbook(BytesIO(response.content), read_only=True)
    assert workbook.sheetnames
    workbook.close()
    assert str(tmp_path) not in response.text


def test_accounting_export_is_binary_xlsx_with_openapi_schema(
    client, monthly_report_env, tmp_path
):
    _seed_report(monthly_report_env, tmp_path)
    project_id = monthly_report_env["project_id"]

    response = client.get(
        "/api/v1/agent/monthly-reports/financial-series/accounting-detail/export"
        f"?project_id={project_id}&country=US&report_month=2026-10",
        headers=monthly_report_env["headers"],
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith(XLSX_MEDIA_TYPE)
    assert response.content[:2] == b"PK"
    assert response.headers["content-length"] == str(len(response.content))
    assert "filename*=UTF-8''" in response.headers["content-disposition"]
    workbook = load_workbook(BytesIO(response.content), read_only=True)
    assert "报表核算" in workbook.sheetnames
    workbook.close()

    from app.api.v1.lazy_router import preload_all_lazy_groups

    preload_all_lazy_groups()
    operation = app.openapi()["paths"][
        "/api/v1/agent/monthly-reports/financial-series/accounting-detail/export"
    ]["get"]
    assert operation["responses"]["200"]["content"][XLSX_MEDIA_TYPE]["schema"] == {
        "type": "string",
        "format": "binary",
    }


def test_monthly_report_reads_enforce_business_and_project_scope(
    client, monthly_report_env, tmp_path, make_api_key
):
    report_id = _seed_report(monthly_report_env, tmp_path)
    out_of_project_scope = make_api_key(
        agent_id="monthly-report-read-out-of-scope",
        business_scope="monthly_reports",
        project_scope="99999999",
    )
    response = client.get(
        f"/api/v1/agent/monthly-reports/{report_id}",
        headers=_headers(out_of_project_scope),
    )
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"
    blocked_download = client.get(
        f"/api/v1/agent/monthly-reports/{report_id}/export",
        headers=_headers(out_of_project_scope),
    )
    assert blocked_download.status_code == 403
    assert blocked_download.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    scoped_to_project = make_api_key(
        agent_id="monthly-report-read-in-scope",
        business_scope="monthly_reports",
        project_scope=str(monthly_report_env["project_id"]),
    )
    allowed = client.get(
        f"/api/v1/agent/monthly-reports/{report_id}",
        headers=_headers(scoped_to_project),
    )
    assert allowed.status_code == 200, allowed.text

    out_of_business_scope = make_api_key(
        agent_id="monthly-report-read-wrong-domain",
        business_scope="shipments",
        project_scope="*",
    )
    response = client.get(
        f"/api/v1/agent/monthly-reports?project_id={monthly_report_env['project_id']}",
        headers=_headers(out_of_business_scope),
    )
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"


def test_project_scope_revocation_blocks_existing_report_reads(
    client, monthly_report_env, tmp_path
):
    report_id = _seed_report(monthly_report_env, tmp_path)
    db = SessionLocal()
    try:
        key = db.query(AgentApiKey).filter_by(id=monthly_report_env["key_id"]).one()
        key.project_scope = "99999999"
        db.commit()
    finally:
        db.close()

    response = client.get(
        f"/api/v1/agent/monthly-reports/{report_id}",
        headers=monthly_report_env["headers"],
    )
    assert response.status_code == 403, response.text
    assert response.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"


def test_monthly_financial_series_returns_zeros_for_empty_project_and_detail_is_404(
    client, monthly_report_env
):
    project_id = monthly_report_env["project_id"]
    series = client.get(
        "/api/v1/agent/monthly-reports/financial-series"
        f"?project_id={project_id}&start_month=2026-10&end_month=2026-10",
        headers=monthly_report_env["headers"],
    )
    assert series.status_code == 200, series.text
    row = series.json()["data"]["rows"][0]
    assert row["report_month"] == "2026-10"
    assert row["has_source_report"] is False
    assert row["income_total"] == 0
    assert row["expense_total"] == 0

    detail = client.get(
        "/api/v1/agent/monthly-reports/financial-series/accounting-detail"
        f"?project_id={project_id}&country=US&report_month=2026-10",
        headers=monthly_report_env["headers"],
    )
    assert detail.status_code == 404
    assert detail.json()["ok"] is False
    assert detail.json()["error"]["code"] == "RESOURCE_NOT_FOUND"


def test_monthly_report_missing_ids_and_invalid_month_use_agent_error_shell(
    client, monthly_report_env
):
    missing = client.get(
        "/api/v1/agent/monthly-reports/999999999",
        headers=monthly_report_env["headers"],
    )
    assert missing.status_code == 404
    assert missing.json()["ok"] is False
    assert missing.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    invalid = client.get(
        "/api/v1/agent/monthly-reports/financial-series"
        f"?project_id={monthly_report_env['project_id']}&start_month=2026-13",
        headers=monthly_report_env["headers"],
    )
    assert invalid.status_code == 400
    assert invalid.json()["ok"] is False
    assert invalid.json()["error"]["code"] == "VALIDATION_FAILED"


def test_report_download_openapi_declares_binary_xlsx_response():
    from app.api.v1.lazy_router import preload_all_lazy_groups

    preload_all_lazy_groups()
    operation = app.openapi()["paths"][
        "/api/v1/agent/monthly-reports/{report_id}/export"
    ]["get"]
    assert operation["responses"]["200"]["content"][XLSX_MEDIA_TYPE]["schema"] == {
        "type": "string",
        "format": "binary",
    }

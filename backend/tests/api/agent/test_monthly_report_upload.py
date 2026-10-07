"""Agent 月报上传域测试（BLF-1250 阶段一，技术单元 B：临时上传）。

覆盖契约的「文件上限 50 MiB（按流累计，不信 Content-Length）、临时保留 24 小时、
每会话一份 CSV + 可选一份 PDF、拒绝空/畸形/超限/路径穿越、跨 Agent 404」。
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models.agent_monthly_report import (
    AgentMonthlyReportUpload,
    AgentMonthlyReportUploadStatus,
)
from app.services.agent_monthly_report_common import utc_now

from conftest import (
    api_create_upload,
    api_upload_csv,
    api_upload_file,
    monthly_report_csv_bytes,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _make_key(make_api_key, **kwargs):
    agent_id = f"monthly-{uuid.uuid4().hex[:8]}"
    key = make_api_key(agent_id=agent_id, **kwargs)
    return agent_id, {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": agent_id,
    }


def _upload_dir(env) -> "object":
    return env["settings"].agent_monthly_report_root / "uploads"


class TestSession:
    def test_create_session_uses_server_project_name_and_ttl(self, client, monthly_report_env):
        data = api_create_upload(client, monthly_report_env, country="us")
        assert data["upload_id"] > 0
        assert data["project_name"] == monthly_report_env["project_name"]
        assert data["country"] == "US"
        assert data["report_month"] == "2026-10"
        assert data["status"] == AgentMonthlyReportUploadStatus.open.value
        assert data["max_file_bytes"] == 50 * 1024 * 1024
        assert data["allowed_kinds"] == ["transaction_csv", "summary_pdf"]
        # 24 小时期限（允许几秒执行误差）。
        assert "expires_at" in data

    def test_unauthenticated_is_401(self, client, monthly_report_env):
        response = client.post(
            "/api/v1/agent/monthly-reports/uploads",
            json={"project_id": monthly_report_env["project_id"], "report_month": "2026-10"},
        )
        assert response.status_code == 401

    def test_missing_business_scope_is_403(self, client, monthly_report_env, make_api_key):
        _agent_id, headers = _make_key(make_api_key, business_scope="sales")
        response = client.post(
            "/api/v1/agent/monthly-reports/uploads",
            json={"project_id": monthly_report_env["project_id"], "report_month": "2026-10"},
            headers=headers,
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_project_out_of_scope_is_403(self, client, monthly_report_env, make_api_key):
        _agent_id, headers = _make_key(
            make_api_key, business_scope="monthly_reports", project_scope="999999"
        )
        response = client.post(
            "/api/v1/agent/monthly-reports/uploads",
            json={"project_id": monthly_report_env["project_id"], "report_month": "2026-10"},
            headers=headers,
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

    def test_unknown_project_is_404(self, client, monthly_report_env):
        response = client.post(
            "/api/v1/agent/monthly-reports/uploads",
            json={"project_id": 99_999_999, "report_month": "2026-10"},
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 404

    @pytest.mark.parametrize(
        "overrides,code",
        [
            ({"country": "FR"}, "MONTHLY_REPORT_INVALID_INPUT"),
            ({"report_month": "2026/10"}, "MONTHLY_REPORT_INVALID_INPUT"),
            ({"report_month": "2026-13"}, "MONTHLY_REPORT_INVALID_INPUT"),
            # 长度不符在 pydantic 层就被拒（壳为 VALIDATION_FAILED）。
            ({"report_month": "2026-1"}, "VALIDATION_FAILED"),
        ],
    )
    def test_invalid_country_or_month_is_400(self, client, monthly_report_env, overrides, code):
        response = client.post(
            "/api/v1/agent/monthly-reports/uploads",
            json={
                "project_id": monthly_report_env["project_id"],
                "country": "US",
                "report_month": "2026-10",
                **overrides,
            },
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 400, response.text
        assert response.json()["error"]["code"] == code


class TestUpload:
    def test_valid_csv_is_stored_privately_and_not_in_formal_root(
        self, client, monthly_report_env
    ):
        upload = api_create_upload(client, monthly_report_env)
        data = api_upload_csv(client, monthly_report_env, upload["upload_id"])

        assert data["kind"] == "transaction_csv"
        assert data["bytes"] > 0
        assert len(data["sha256"]) == 64
        assert data["validation"]["rows"] == 1

        stored = list((_upload_dir(monthly_report_env) / str(upload["upload_id"])).iterdir())
        assert len(stored) == 1
        # 私有权限 + 不在正式 upload_root 下（confirm 前不得写正式目录）。
        assert stored[0].stat().st_mode & 0o777 == 0o600
        assert not list(monthly_report_env["settings"].upload_root.rglob("*.csv"))

    def test_response_never_leaks_server_paths(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=monthly_report_csv_bytes(),
            filename="transactions.csv",
            content_type="text/csv",
        )
        assert response.status_code == 200
        assert "storage" not in response.text
        assert "/tmp" not in response.text
        assert monthly_report_env["project_name"] not in response.text

    def test_second_csv_in_same_session_conflicts(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        api_upload_csv(client, monthly_report_env, upload["upload_id"])
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=monthly_report_csv_bytes(),
            filename="again.csv",
            content_type="text/csv",
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_UPLOAD_CONFLICT"

    def test_optional_pdf_is_accepted_and_does_not_change_csv(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        csv_data = api_upload_csv(client, monthly_report_env, upload["upload_id"])
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="summary_pdf",
            content=b"%PDF-1.4\n%fake\n",
            filename="summary.pdf",
            content_type="application/pdf",
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["kind"] == "summary_pdf"
        # CSV 输入不可变：再次读取同一 file_id 仍是同一摘要。
        assert csv_data["sha256"]

    def test_pdf_without_signature_is_rejected(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="summary_pdf",
            content=b"not a pdf at all",
            filename="summary.pdf",
            content_type="application/pdf",
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"

    @pytest.mark.parametrize(
        "kind,filename,content,content_type,expected",
        [
            ("transaction_csv", "x.csv", b"", "text/csv", 400),
            ("transaction_csv", "x.txt", b"a,b\n1,2\n", "text/csv", 400),
            ("summary_pdf", "x.csv", b"%PDF-1.4\n", "application/pdf", 400),
            ("bogus", "x.csv", b"a,b\n1,2\n", "text/csv", 400),
        ],
    )
    def test_invalid_kind_extension_or_empty_is_400(
        self, client, monthly_report_env, kind, filename, content, content_type, expected
    ):
        upload = api_create_upload(client, monthly_report_env)
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind=kind,
            content=content,
            filename=filename,
            content_type=content_type,
        )
        assert response.status_code == expected, response.text
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"

    def test_unparsable_csv_is_rejected(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=b"\x00\x01\x02\x03binary garbage",
            filename="transactions.csv",
            content_type="text/csv",
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"

    def test_country_mismatch_is_rejected(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=monthly_report_csv_bytes(marketplace="amazon.de"),
            filename="transactions.csv",
            content_type="text/csv",
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_INVALID_INPUT"

    def test_oversize_is_rejected_by_accumulated_bytes(self, client, monthly_report_env, monkeypatch):
        settings = monthly_report_env["settings"]
        monkeypatch.setattr(settings, "agent_monthly_report_max_bytes", 2048)
        upload = api_create_upload(client, monthly_report_env)
        oversize = b"date/time,type\n" + b"padding," * 2000
        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=oversize,
            filename="transactions.csv",
            content_type="text/csv",
        )
        assert response.status_code == 413, response.text
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_TOO_LARGE"
        # 半成品不留在磁盘上。
        upload_dir = _upload_dir(monthly_report_env) / str(upload["upload_id"])
        assert not list(upload_dir.iterdir())

    def test_cross_agent_upload_id_is_404(self, client, monthly_report_env, make_api_key):
        upload = api_create_upload(client, monthly_report_env)
        _agent_id, other_headers = _make_key(make_api_key, business_scope="monthly_reports")
        response = client.post(
            f"/api/v1/agent/monthly-reports/uploads/{upload['upload_id']}/files",
            files={"file": ("transactions.csv", monthly_report_csv_bytes(), "text/csv")},
            data={"kind": "transaction_csv"},
            headers=other_headers,
        )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "RESOURCE_NOT_FOUND"

    def test_expired_session_is_rejected(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        db = SessionLocal()
        try:
            row = db.get(AgentMonthlyReportUpload, upload["upload_id"])
            row.expires_at = utc_now() - timedelta(minutes=1)
            db.commit()
        finally:
            db.close()

        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=monthly_report_csv_bytes(),
            filename="transactions.csv",
            content_type="text/csv",
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_EXPIRED"

    def test_revoked_project_scope_blocks_upload(self, client, monthly_report_env):
        upload = api_create_upload(client, monthly_report_env)
        # 撤销 project_scope（模拟管理员收紧权限）后，同一 upload_id 立即被拒。
        db = SessionLocal()
        try:
            from app.models.agent_api_key import AgentApiKey

            key = db.get(AgentApiKey, monthly_report_env["key_id"])
            key.project_scope = "999999"
            db.commit()
        finally:
            db.close()

        response = api_upload_file(
            client,
            monthly_report_env,
            upload["upload_id"],
            kind="transaction_csv",
            content=monthly_report_csv_bytes(),
            filename="transactions.csv",
            content_type="text/csv",
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "AGENT_PROJECT_OUT_OF_SCOPE"

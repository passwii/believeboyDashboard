"""Agent 月报仅计算草稿测试（BLF-1250 阶段一，技术单元 B：异步 build）。

覆盖契约的「build 只写临时表、正式表行数不变、Celery 用数据库领取（重复投递不
重复执行）、派发失败可重试、24 小时过期、状态端点不泄漏服务器路径」。
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.db.session import SessionLocal
from app.main import app
from app.models import MonthlyReport
from app.models.agent_monthly_report import (
    AgentMonthlyReportBuild,
    AgentMonthlyReportBuildStatus,
)
from app.services.agent_monthly_report_build_service import claim_queued_build
from app.services.agent_monthly_report_common import utc_now

from conftest import (
    api_create_build,
    api_create_upload,
    api_upload_csv,
    api_upload_file,
    monthly_report_csv_bytes,
    run_build_inline,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _ready_upload(client, env) -> tuple[int, str]:
    upload = api_create_upload(client, env)
    csv_data = api_upload_csv(client, env, upload["upload_id"])
    return upload["upload_id"], csv_data["file_id"]


def _formal_report_count(project_id: int) -> int:
    db = SessionLocal()
    try:
        return (
            db.query(MonthlyReport)
            .filter(MonthlyReport.project_id == project_id)
            .count()
        )
    finally:
        db.close()


class TestCreateBuild:
    def test_build_is_queued_and_writes_no_formal_rows(
        self, client, monthly_report_env, fake_dispatch
    ):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        before = _formal_report_count(monthly_report_env["project_id"])

        response = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        assert response.status_code == 202, response.text
        body = response.json()
        assert body["ok"] is True
        assert body["data"]["status"] == AgentMonthlyReportBuildStatus.queued.value
        assert body["status_endpoint"].endswith(f"/builds/{body['data']['build_id']}")
        assert fake_dispatch == [body["data"]["build_id"]]
        assert _formal_report_count(monthly_report_env["project_id"]) == before

    def test_missing_idempotency_key_is_rejected(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        response = client.post(
            "/api/v1/agent/monthly-reports/builds",
            json={"upload_id": upload_id, "transaction_file_id": file_id},
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"

    def test_unknown_file_id_is_404(self, client, monthly_report_env, fake_dispatch):
        upload_id, _file_id = _ready_upload(client, monthly_report_env)
        response = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id="nope"
        )
        assert response.status_code == 404

    def test_same_key_same_body_replays_same_build(
        self, client, monthly_report_env, fake_dispatch
    ):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        key = f"idem-{uuid.uuid4().hex[:12]}"
        first = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            idempotency_key=key,
        )
        assert first.status_code == 202
        second = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            idempotency_key=key,
        )
        assert second.status_code == 200
        assert second.json()["replayed"] is True
        assert (
            second.json()["data"]["build_id"] == first.json()["data"]["build_id"]
        )
        assert len(fake_dispatch) == 1

    def test_same_key_different_body_conflicts(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        key = f"idem-{uuid.uuid4().hex[:12]}"
        api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            idempotency_key=key,
        )
        second = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id="other-file",
            idempotency_key=key,
        )
        assert second.status_code == 409
        assert second.json()["error"]["code"] == "IDEMPOTENCY_KEY_CONFLICT"

    def test_dispatch_failure_is_retryable_with_same_key(
        self, client, monthly_report_env, monkeypatch
    ):
        from app.services import agent_monthly_report_build_service as build_service

        def _boom(build_id: int) -> str:
            raise RuntimeError("broker down")

        monkeypatch.setattr(build_service, "dispatch_build", _boom)
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        key = f"idem-{uuid.uuid4().hex[:12]}"
        response = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            idempotency_key=key,
        )
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_DISPATCH_FAILED"

        db = SessionLocal()
        try:
            build = (
                db.query(AgentMonthlyReportBuild)
                .filter(AgentMonthlyReportBuild.idempotency_key == key)
                .one()
            )
            assert build.status == AgentMonthlyReportBuildStatus.failed.value
            assert build.error_message == "dispatch_failed"
        finally:
            db.close()

        # 派发失败不占用幂等键：同一 key 重试会新建 build。
        monkeypatch.setattr(build_service, "dispatch_build", lambda build_id: f"t-{build_id}")
        retry = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            idempotency_key=key,
        )
        assert retry.status_code == 202, retry.text

    def test_cross_agent_build_is_404(self, client, monthly_report_env, fake_dispatch, make_api_key):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        response = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = response.json()["data"]["build_id"]

        other_agent = f"monthly-{uuid.uuid4().hex[:8]}"
        other_key = make_api_key(agent_id=other_agent, business_scope="monthly_reports")
        headers = {
            "Authorization": f"Bearer {other_key['plaintext']}",
            "X-Agent-Id": other_agent,
        }
        assert (
            client.get(
                f"/api/v1/agent/monthly-reports/builds/{build_id}", headers=headers
            ).status_code
            == 404
        )


class TestBuildExecution:
    def test_inline_build_success_preview_and_result(
        self, client, monthly_report_env, fake_dispatch
    ):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]

        result = run_build_inline(build_id)
        assert result["status"] == "success", result

        status = client.get(
            f"/api/v1/agent/monthly-reports/builds/{build_id}",
            headers=monthly_report_env["headers"],
        )
        assert status.status_code == 200, status.text
        payload = status.json()["data"]
        assert payload["status"] == AgentMonthlyReportBuildStatus.success.value
        assert payload["report_id"] is None
        assert payload["existing_success_report_id"] is None
        assert payload["calculation_version"] == 1
        assert "storage" not in status.text

        preview = client.get(
            f"/api/v1/agent/monthly-reports/builds/{build_id}/preview",
            headers=monthly_report_env["headers"],
        )
        assert preview.status_code == 200, preview.text
        preview_body = preview.json()["data"]
        assert preview_body["transactions_count"] == 1
        assert preview_body["pt4"]["amazon_pay_back"] == "8.77"
        assert preview_body["pt3"]["income_total"] == "12.34"
        # 预览不返回逐条交易明细。
        assert "transactions" not in preview_body

        downloaded = client.get(
            f"/api/v1/agent/monthly-reports/builds/{build_id}/result",
            headers=monthly_report_env["headers"],
        )
        assert downloaded.status_code == 200, downloaded.text
        assert downloaded.content[:2] == b"PK"
        assert (
            downloaded.headers["content-type"]
            == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
        # 草稿阶段不写正式表。
        assert _formal_report_count(monthly_report_env["project_id"]) == 0

    def test_repeated_delivery_does_not_re_execute(
        self, client, monthly_report_env, fake_dispatch
    ):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]
        assert run_build_inline(build_id)["status"] == "success"

        # 重复投递（acks_late 重投）第二次必须跳过，不重算。
        assert run_build_inline(build_id)["status"] == "skipped"

        db = SessionLocal()
        try:
            assert claim_queued_build(db, build_id) is False
            build = db.get(AgentMonthlyReportBuild, build_id)
            assert build.attempt_count == 1
        finally:
            db.close()

    def test_csv_only_build_ignores_missing_pdf(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]
        assert run_build_inline(build_id)["status"] == "success"
        db = SessionLocal()
        try:
            build = db.get(AgentMonthlyReportBuild, build_id)
            assert build.summary_pdf_sha256 is None
        finally:
            db.close()

    def test_unknown_pdf_file_id_is_404(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        response = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            summary_pdf_file_id="missing-pdf",
        )
        assert response.status_code == 404

    def test_pdf_upload_is_bound_to_build(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        pdf = api_upload_file(
            client,
            monthly_report_env,
            upload_id,
            kind="summary_pdf",
            content=b"%PDF-1.4\n%fake\n",
            filename="summary.pdf",
            content_type="application/pdf",
        )
        pdf_id = pdf.json()["data"]["file_id"]
        created = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            summary_pdf_file_id=pdf_id,
        )
        build_id = created.json()["data"]["build_id"]
        assert run_build_inline(build_id)["status"] == "success"
        db = SessionLocal()
        try:
            assert db.get(AgentMonthlyReportBuild, build_id).summary_pdf_sha256
        finally:
            db.close()


class TestBuildGuards:
    def test_expired_build_blocks_preview_and_result(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]
        assert run_build_inline(build_id)["status"] == "success"

        db = SessionLocal()
        try:
            build = db.get(AgentMonthlyReportBuild, build_id)
            build.expires_at = utc_now() - timedelta(minutes=1)
            db.commit()
        finally:
            db.close()

        for suffix in ("preview", "result"):
            response = client.get(
                f"/api/v1/agent/monthly-reports/builds/{build_id}/{suffix}",
                headers=monthly_report_env["headers"],
            )
            assert response.status_code == 409, response.text
            assert response.json()["error"]["code"] == "MONTHLY_REPORT_EXPIRED"

    def test_revoked_business_scope_blocks_reads(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]

        db = SessionLocal()
        try:
            from app.models.agent_api_key import AgentApiKey

            key = db.get(AgentApiKey, monthly_report_env["key_id"])
            key.business_scope = "sales"
            db.commit()
        finally:
            db.close()

        response = client.get(
            f"/api/v1/agent/monthly-reports/builds/{build_id}",
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "AGENT_BUSINESS_OUT_OF_SCOPE"

    def test_preview_before_completion_is_409(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]
        response = client.get(
            f"/api/v1/agent/monthly-reports/builds/{build_id}/preview",
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_NOT_READY"

    def test_tampered_artifacts_fail_closed(self, client, monthly_report_env, fake_dispatch):
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]
        assert run_build_inline(build_id)["status"] == "success"

        db = SessionLocal()
        try:
            build = db.get(AgentMonthlyReportBuild, build_id)
            from pathlib import Path

            Path(build.workbook_path).write_bytes(b"tampered")
        finally:
            db.close()

        response = client.get(
            f"/api/v1/agent/monthly-reports/builds/{build_id}/result",
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_NOT_READY"

    def test_unparsable_csv_fails_build_without_formal_rows(
        self, client, monthly_report_env, fake_dispatch, monkeypatch
    ):
        # 绕过上传期校验，直接构造「输入被替换」场景：build 必须 fail closed。
        upload_id, file_id = _ready_upload(client, monthly_report_env)
        created = api_create_build(
            client, monthly_report_env, upload_id=upload_id, transaction_file_id=file_id
        )
        build_id = created.json()["data"]["build_id"]

        db = SessionLocal()
        try:
            from pathlib import Path

            from app.models.agent_monthly_report import AgentMonthlyReportFile

            row = db.query(AgentMonthlyReportFile).filter(
                AgentMonthlyReportFile.upload_id == upload_id
            ).one()
            Path(row.stored_path).write_bytes(monthly_report_csv_bytes(total="9.99"))
        finally:
            db.close()

        result = run_build_inline(build_id)
        assert result["status"] == "failed"
        assert result["reason"] == "integrity"
        assert _formal_report_count(monthly_report_env["project_id"]) == 0

"""Agent 月报确认入库测试（BLF-1250 阶段一，技术单元 C）。

覆盖契约的「两步确认 + 数据库幂等（响应丢失重试返回同 report_id）、同月成功月报
拒绝、并发串行化、晋升/入库失败补偿、拒绝原因审计」。
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func

from app.api.agent.confirm import (
    InMemoryConfirmStore,
    get_confirm_store,
    set_confirm_store,
)
from app.db.session import SessionLocal
from app.main import app
from app.models import (
    MonthlyReport,
    MonthlyReportPT3Calculation,
    MonthlyReportPT4Calculation,
    MonthlyReportTransaction,
)
from app.models.agent_monthly_report import AgentMonthlyReportBuild
from app.models.job import JobStatus
from app.services.report.monthly import prepare_monthly_report

from conftest import (
    api_create_build,
    api_create_upload,
    api_upload_csv,
    run_build_inline,
)

pytestmark = pytest.mark.audit_table_isolation


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def confirm_memory_store():
    """confirm 测试注入内存 store：不依赖 Redis，也便于断言 token 已消费。"""
    set_confirm_store(InMemoryConfirmStore())
    try:
        yield get_confirm_store()
    finally:
        set_confirm_store(None)


def _confirm(client, env, build_id: int, idem: str, token: str | None = None):
    headers = dict(env["headers"])
    headers["Idempotency-Key"] = idem
    if token:
        headers["X-Confirm-Token"] = token
    return client.post(
        f"/api/v1/agent/monthly-reports/builds/{build_id}/confirm",
        json={},
        headers=headers,
    )


def _ready_build(client, env, *, with_pdf: bool = False) -> tuple[int, str, str]:
    upload = api_create_upload(client, env)
    csv_data = api_upload_csv(client, env, upload["upload_id"])
    pdf_id = None
    if with_pdf:
        response = client.post(
            f"/api/v1/agent/monthly-reports/uploads/{upload['upload_id']}/files",
            files={"file": ("summary.pdf", b"%PDF-1.4\n%fake\n", "application/pdf")},
            data={"kind": "summary_pdf"},
            headers=env["headers"],
        )
        assert response.status_code == 200, response.text
        pdf_id = response.json()["data"]["file_id"]
    created = api_create_build(
        client,
        env,
        upload_id=upload["upload_id"],
        transaction_file_id=csv_data["file_id"],
        summary_pdf_file_id=pdf_id,
    )
    assert created.status_code == 202, created.text
    build_id = created.json()["data"]["build_id"]
    assert run_build_inline(build_id)["status"] == "success"
    return upload["upload_id"], build_id, f"idem-{uuid.uuid4().hex[:12]}"


def _reports(project_id: int) -> list[MonthlyReport]:
    db = SessionLocal()
    try:
        return (
            db.query(MonthlyReport)
            .filter(MonthlyReport.project_id == project_id)
            .order_by(MonthlyReport.id)
            .all()
        )
    finally:
        db.close()


def _seed_report(env, *, status: JobStatus) -> int:
    """直接经服务层落一行同键月报（模拟 dashboard 写入）。"""
    db = SessionLocal()
    try:
        report = prepare_monthly_report(
            db,
            project_id=env["project_id"],
            project_name=env["project_name"],
            country="US",
            report_month="2026-10",
            transaction_file_id="seed.csv",
            transaction_file_path="/tmp/seed.csv",
            summary_pdf_file_id=None,
            summary_pdf_file_path=None,
            file_size=1,
        )
        report.status = status
        db.commit()
        return report.id
    finally:
        db.close()


def _formal_files(env) -> list[Path]:
    uploads = list(env["settings"].upload_root.rglob("*"))
    results = list(env["settings"].result_root.rglob("*"))
    return [path for path in uploads + results if path.is_file()]


class TestConfirmHappyPath:
    def test_preview_then_replay_persists_report(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        upload_id, build_id, idem = _ready_build(client, monthly_report_env)

        preview = _confirm(client, monthly_report_env, build_id, idem)
        assert preview.status_code == 200, preview.text
        body = preview.json()
        assert body["ok"] is False
        assert body["requires_confirmation"] is True
        assert body["confirm_token"].startswith("cf_")
        assert body["preview"]["will_conflict"] is False
        assert body["preview"]["transactions_count"] == 1
        # 预览阶段不得有任何正式写入。
        assert _reports(monthly_report_env["project_id"]) == []

        replay = _confirm(
            client, monthly_report_env, build_id, idem, token=body["confirm_token"]
        )
        assert replay.status_code == 200, replay.text
        data = replay.json()["data"]
        assert data["report_id"] is not None
        assert data["replayed"] is False
        assert data["version"] == 1
        assert data["is_current"] is True
        assert data["status"] == JobStatus.success.value

        reports = _reports(monthly_report_env["project_id"])
        assert len(reports) == 1
        report = reports[0]
        assert Path(report.transaction_file_path).is_file()
        assert Path(report.result_file_path).is_file()
        # 正式件不在临时目录里（晋升 = 复制到正式目录）。
        assert not str(report.transaction_file_path).startswith(
            str(monthly_report_env["settings"].agent_monthly_report_root)
        )

        db = SessionLocal()
        try:
            assert (
                db.query(func.count(MonthlyReportTransaction.id))
                .filter(MonthlyReportTransaction.report_id == report.id)
                .scalar()
                == 1
            )
            assert (
                db.query(func.count(MonthlyReportPT3Calculation.id))
                .filter(MonthlyReportPT3Calculation.report_id == report.id)
                .scalar()
                == 1
            )
            assert (
                db.query(func.count(MonthlyReportPT4Calculation.id))
                .filter(MonthlyReportPT4Calculation.report_id == report.id)
                .scalar()
                == 1
            )
            build = db.get(AgentMonthlyReportBuild, build_id)
            assert build.confirmed_at is not None
            assert build.report_id == report.id
        finally:
            db.close()

        # 审计：成功入库一条 agent 归因行。
        from app.models.operation_audit_log import OperationAuditLog

        db = SessionLocal()
        try:
            actions = [
                row.action
                for row in db.query(OperationAuditLog)
                .filter(OperationAuditLog.agent_id == monthly_report_env["agent_id"])
                .all()
            ]
        finally:
            db.close()
        assert "agent_monthly_reports.confirm" in actions

    def test_with_pdf_keeps_optional_attachment(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        _upload_id, build_id, idem = _ready_build(
            client, monthly_report_env, with_pdf=True
        )
        preview = _confirm(client, monthly_report_env, build_id, idem).json()
        assert preview["preview"]["summary_pdf_included"] is True
        replay = _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )
        assert replay.status_code == 200, replay.text
        report = _reports(monthly_report_env["project_id"])[0]
        assert report.summary_pdf_file_id
        assert Path(report.summary_pdf_file_path).is_file()

    def test_lost_response_retry_returns_same_report_id(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        _upload_id, build_id, idem = _ready_build(client, monthly_report_env)
        preview = _confirm(client, monthly_report_env, build_id, idem).json()
        first = _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )
        report_id = first.json()["data"]["report_id"]

        # 响应丢失后同 key + 同请求体重放：token 已被原子 pop，但数据库幂等命中。
        retry = _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )
        assert retry.status_code == 200, retry.text
        assert retry.json()["data"]["report_id"] == report_id
        assert retry.json()["data"]["replayed"] is True
        assert len(_reports(monthly_report_env["project_id"])) == 1

    def test_same_key_different_build_conflicts(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        upload_id, build_id, idem = _ready_build(client, monthly_report_env)
        preview = _confirm(client, monthly_report_env, build_id, idem).json()
        _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )

        # 同一 upload 再建一个 build（输入不变），同幂等键指向不同 build → 409。
        db = SessionLocal()
        try:
            from app.models.agent_monthly_report import AgentMonthlyReportFile

            file_id = (
                db.query(AgentMonthlyReportFile)
                .filter(AgentMonthlyReportFile.upload_id == upload_id)
                .one()
                .file_id
            )
        finally:
            db.close()
        second = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload_id,
            transaction_file_id=file_id,
            idempotency_key=f"idem-{uuid.uuid4().hex[:12]}",
        )
        second_build_id = second.json()["data"]["build_id"]

        response = _confirm(client, monthly_report_env, second_build_id, idem)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "IDEMPOTENCY_KEY_CONFLICT"

    def test_token_reuse_with_new_key_is_invalid(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        _upload_id, build_id, idem = _ready_build(client, monthly_report_env)
        preview = _confirm(client, monthly_report_env, build_id, idem).json()
        _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )
        response = _confirm(
            client,
            monthly_report_env,
            build_id,
            f"idem-{uuid.uuid4().hex[:12]}",
            token=preview["confirm_token"],
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "CONFIRM_TOKEN_INVALID"

    def test_missing_idempotency_key_is_rejected(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        _upload_id, build_id, _idem = _ready_build(client, monthly_report_env)
        response = client.post(
            f"/api/v1/agent/monthly-reports/builds/{build_id}/confirm",
            json={},
            headers=monthly_report_env["headers"],
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"


class TestConfirmConflicts:
    @pytest.mark.parametrize("status", [JobStatus.success, JobStatus.pending])
    def test_existing_report_blocks_confirm_and_writes_nothing(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store, status
    ):
        seeded_id = _seed_report(monthly_report_env, status=status)
        _upload_id, build_id, idem = _ready_build(client, monthly_report_env)

        preview = _confirm(client, monthly_report_env, build_id, idem)
        assert preview.status_code == 200, preview.text
        assert preview.json()["preview"]["will_conflict"] is True
        assert preview.json()["preview"]["existing_report_id"] == seeded_id

        replay = _confirm(
            client, monthly_report_env, build_id, idem, token=preview.json()["confirm_token"]
        )
        assert replay.status_code == 409, replay.text
        assert replay.json()["error"]["code"] == "MONTHLY_REPORT_CONFLICT"

        reports = _reports(monthly_report_env["project_id"])
        assert [report.id for report in reports] == [seeded_id]
        # 冲突在晋升之前判定：不产生任何正式文件。
        assert _formal_files(monthly_report_env) == []

        from app.models.operation_audit_log import OperationAuditLog

        db = SessionLocal()
        try:
            failures = (
                db.query(OperationAuditLog)
                .filter(
                    OperationAuditLog.action == "agent_monthly_reports.confirm",
                    OperationAuditLog.result == "failure",
                )
                .all()
            )
            assert failures
        finally:
            db.close()

    def test_non_current_success_report_still_blocks_confirm(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        """同键只要存在任一 success 月报就拒绝——含已被新版取代的非 current 版本。"""
        older_id = _seed_report(monthly_report_env, status=JobStatus.success)
        newest_id = _seed_report(monthly_report_env, status=JobStatus.failed)
        db = SessionLocal()
        try:
            older = db.get(MonthlyReport, older_id)
            newest = db.get(MonthlyReport, newest_id)
            older.is_current = False
            newest.is_current = True
            db.commit()
        finally:
            db.close()

        _upload_id, build_id, idem = _ready_build(client, monthly_report_env)
        preview = _confirm(client, monthly_report_env, build_id, idem)
        assert preview.status_code == 200, preview.text
        # 预览指向阻塞源（旧的成功版本），而不是当前的失败版本。
        assert preview.json()["preview"]["existing_report_id"] == older_id
        assert preview.json()["preview"]["will_conflict"] is True

        replay = _confirm(
            client, monthly_report_env, build_id, idem, token=preview.json()["confirm_token"]
        )
        assert replay.status_code == 409, replay.text
        assert replay.json()["error"]["code"] == "MONTHLY_REPORT_CONFLICT"
        assert [report.id for report in _reports(monthly_report_env["project_id"])] == [
            older_id,
            newest_id,
        ]
        assert _formal_files(monthly_report_env) == []

    def test_confirm_on_failed_build_is_409(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store
    ):
        upload = api_create_upload(client, monthly_report_env)
        csv_data = api_upload_csv(client, monthly_report_env, upload["upload_id"])
        created = api_create_build(
            client,
            monthly_report_env,
            upload_id=upload["upload_id"],
            transaction_file_id=csv_data["file_id"],
        )
        build_id = created.json()["data"]["build_id"]
        # 不执行 build：状态仍 queued。
        idem = f"idem-{uuid.uuid4().hex[:12]}"
        response = _confirm(client, monthly_report_env, build_id, idem)
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "MONTHLY_REPORT_NOT_READY"


class TestConfirmCompensation:
    def test_promotion_failure_leaves_no_formal_writes(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store, monkeypatch
    ):
        from app.services import agent_monthly_report_confirm_service as confirm_service

        real_copy = confirm_service.shutil.copyfile

        def flaky_copy(src, dst):
            # 正式 XLSX 复制失败：前两个（若已写入）正式件必须被撤销。
            if str(dst).endswith(".xlsx"):
                raise OSError("disk full")
            return real_copy(src, dst)

        monkeypatch.setattr(confirm_service.shutil, "copyfile", flaky_copy)
        _upload_id, build_id, idem = _ready_build(client, monthly_report_env)
        preview = _confirm(client, monthly_report_env, build_id, idem).json()
        response = _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )
        assert response.status_code == 500, response.text
        assert response.json()["error"]["code"] == "INTERNAL_ERROR"
        assert _reports(monthly_report_env["project_id"]) == []
        assert _formal_files(monthly_report_env) == []

    def test_db_failure_rolls_back_and_compensates(
        self, client, monthly_report_env, fake_dispatch, confirm_memory_store, monkeypatch
    ):
        from app.services import agent_monthly_report_confirm_service as confirm_service

        def boom(*args, **kwargs):
            raise RuntimeError("db write failed")

        monkeypatch.setattr(confirm_service, "persist_monthly_report_result", boom)
        _upload_id, build_id, idem = _ready_build(client, monthly_report_env)
        preview = _confirm(client, monthly_report_env, build_id, idem).json()
        response = _confirm(
            client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
        )
        assert response.status_code == 500, response.text
        assert response.json()["error"]["code"] == "INTERNAL_ERROR"

        # DB 回滚 + 晋升撤销；build 未标记 confirmed；幂等记录未落（可用同 key 重试）。
        assert _reports(monthly_report_env["project_id"]) == []
        assert _formal_files(monthly_report_env) == []
        db = SessionLocal()
        try:
            build = db.get(AgentMonthlyReportBuild, build_id)
            assert build.confirmed_at is None
            assert build.report_id is None
            from app.models.agent_monthly_report import AgentMonthlyReportIdempotency

            assert (
                db.query(AgentMonthlyReportIdempotency)
                .filter(
                    AgentMonthlyReportIdempotency.idempotency_key == idem,
                    AgentMonthlyReportIdempotency.action == "confirm",
                )
                .count()
                == 0
            )
        finally:
            db.close()

        # 结果仍在期限内：修好后用同一 key 重试即可成功（不需要重新上传）。
        monkeypatch.undo()
        preview_again = _confirm(client, monthly_report_env, build_id, idem)
        assert preview_again.status_code == 200, preview_again.text
        retry = _confirm(
            client,
            monthly_report_env,
            build_id,
            idem,
            token=preview_again.json()["confirm_token"],
        )
        assert retry.status_code == 200, retry.text
        assert retry.json()["data"]["report_id"] is not None
        assert len(_reports(monthly_report_env["project_id"])) == 1


def test_committed_confirm_never_deletes_formal_files(
    client, monthly_report_env, fake_dispatch, confirm_memory_store, monkeypatch
):
    """事务已提交后即便响应/清理阶段失败，也绝不删除已晋升的正式文件。

    补偿只允许发生在 ``committed=False`` 时：删除正式文件会让已入库的月报指向
    磁盘上不存在的路径（数据丢失面比冗余文件严重得多）。
    """
    from app.models.agent_monthly_report import AgentMonthlyReportUpload
    from app.services import agent_monthly_report_confirm_service as confirm_service

    upload_id, build_id, idem = _ready_build(client, monthly_report_env)
    preview = _confirm(client, monthly_report_env, build_id, idem).json()

    def boom(*args, **kwargs):
        raise RuntimeError("response rendering failed")

    monkeypatch.setattr(confirm_service, "_confirmed_payload", boom)
    db = SessionLocal()
    try:
        build = db.get(AgentMonthlyReportBuild, build_id)
        upload = db.get(AgentMonthlyReportUpload, build.upload_id)
        with pytest.raises(RuntimeError):
            confirm_service.perform_confirm(
                db,
                monthly_report_env["settings"],
                build=build,
                upload=upload,
                idempotency_key=idem,
                request_hash=confirm_service.confirm_request_hash(build_id, b"{}"),
            )
        db.expire_all()
        committed = db.get(AgentMonthlyReportBuild, build_id)
        assert committed.confirmed_at is not None
        assert committed.report_id is not None
        report = db.get(MonthlyReport, committed.report_id)
    finally:
        db.close()

    # 正式行与正式文件都在：没有被补偿删掉。
    assert report is not None
    assert Path(report.transaction_file_path).is_file()
    assert Path(report.result_file_path).is_file()
    assert _formal_files(monthly_report_env)

    # 幂等记录已落库 → 用同一 key 重试拿到同一个 report_id，不新增版本。
    monkeypatch.undo()
    retry = _confirm(
        client, monthly_report_env, build_id, idem, token=preview["confirm_token"]
    )
    assert retry.status_code == 200, retry.text
    assert retry.json()["data"]["report_id"] == committed.report_id
    assert len(_reports(monthly_report_env["project_id"])) == 1

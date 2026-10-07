"""Agent 月报：仅计算草稿的异步 build（BLF-1250 阶段一，技术单元 B）。

build 只调用增量 A 的 ``build_preview``（计算内核，不建 Job / MonthlyReport /
财务明细），结果落服务端私有目录；状态落 ``agent_monthly_report_builds``，跨
API/Celery 进程可读（不用内存 dict 当状态源）。

并发与恢复：

* 领取用数据库原子更新（``UPDATE ... WHERE status='queued'``），重复投递不重复执行；
* 派发失败（broker 不可用）→ 任务置 failed 并撤掉幂等记录，Agent 可用同一 key 重试；
* worker 被杀导致长期 running → 由 janitor 按硬超时恢复为 failed 并清理目录。
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from billiard.exceptions import SoftTimeLimitExceeded
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.core.config import Settings
from app.models.agent_monthly_report import (
    AgentMonthlyReportBuild,
    AgentMonthlyReportBuildStatus,
    AgentMonthlyReportFile,
    AgentMonthlyReportUpload,
)
from app.services.agent_monthly_report_common import (
    CSV_KIND,
    IDEMPOTENCY_BUILD,
    PDF_KIND,
    assert_not_expired,
    assert_same_request,
    build_dir,
    ensure_private_root,
    find_idempotency,
    record_idempotency,
    refresh_upload_status,
    remove_tree_best_effort,
    sha256_file,
    utc_now,
)
from app.services.monthly_report_preview_service import (
    CALCULATION_VERSION,
    PreviewArtifacts,
    PreviewIntegrityError,
    build_preview,
    load_preview,
)

logger = logging.getLogger(__name__)


def _file_or_404(db: Session, *, upload_id: int, file_id: str, kind: str) -> AgentMonthlyReportFile:
    row = db.execute(
        select(AgentMonthlyReportFile).where(
            AgentMonthlyReportFile.upload_id == upload_id,
            AgentMonthlyReportFile.file_id == file_id,
            AgentMonthlyReportFile.kind == kind,
        )
    ).scalar_one_or_none()
    if row is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"{kind} 文件不存在于该会话",
            agent_hint="file_id 来自 POST /uploads/{upload_id}/files 的响应",
        )
    return row


def start_build(
    db: Session,
    settings: Settings,
    *,
    upload: AgentMonthlyReportUpload,
    transaction_file_id: str,
    summary_pdf_file_id: str | None,
    idempotency_key: str,
    request_hash: str,
) -> tuple[AgentMonthlyReportBuild, bool]:
    """建 build（返回 (build, replayed)）。replayed=True 表示幂等重放。"""
    assert_not_expired(upload)

    existing = find_idempotency(
        db,
        agent_api_key_id=upload.agent_api_key_id,
        action=IDEMPOTENCY_BUILD,
        idempotency_key=idempotency_key,
    )
    if existing is not None:
        assert_same_request(existing, request_hash)
        if existing.build_id is not None:
            replayed = db.get(AgentMonthlyReportBuild, existing.build_id)
            if replayed is not None:
                return replayed, True

    transaction_file = _file_or_404(
        db, upload_id=upload.id, file_id=transaction_file_id, kind=CSV_KIND
    )
    summary_pdf = (
        _file_or_404(
            db, upload_id=upload.id, file_id=summary_pdf_file_id, kind=PDF_KIND
        )
        if summary_pdf_file_id
        else None
    )

    build = AgentMonthlyReportBuild(
        upload_id=upload.id,
        agent_api_key_id=upload.agent_api_key_id,
        agent_id=upload.agent_id,
        status=AgentMonthlyReportBuildStatus.queued.value,
        input_sha256=transaction_file.sha256,
        summary_pdf_sha256=summary_pdf.sha256 if summary_pdf else None,
        idempotency_key=idempotency_key,
        expires_at=upload.expires_at,
    )
    db.add(build)
    db.flush()
    # Tia 增量 A 评审建议 #2：私有根与中间层由调用方预建并显式 0o700。
    # **不预建 build 叶子目录**——``build_preview`` 用 exist_ok=False 独占创建它。
    ensure_private_root(settings)
    record_idempotency(
        db,
        agent_api_key_id=upload.agent_api_key_id,
        action=IDEMPOTENCY_BUILD,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        build_id=build.id,
    )
    refresh_upload_status(db, upload)
    db.flush()
    return build, False


def dispatch_build(build_id: int) -> str | None:
    """派发到 ``reports`` 队列；返回 celery task id（测试可 monkeypatch）。"""
    from app.celery_tasks.monthly_report_preview import build_monthly_report_preview

    result = build_monthly_report_preview.delay(build_id)
    return getattr(result, "id", None)


def enqueue_build(db: Session, build: AgentMonthlyReportBuild) -> AgentMonthlyReportBuild:
    """提交后派发；broker 不可用则置 failed + 撤幂等记录，返回可重试错误。"""
    build_id = build.id
    try:
        task_id = dispatch_build(build_id)
    except Exception as exc:  # noqa: BLE001 — 任何派发失败都走可重试路径
        logger.warning("dispatch build %s failed: %s", build_id, exc)
        build.status = AgentMonthlyReportBuildStatus.failed.value
        build.error_message = "dispatch_failed"
        build.finished_at = utc_now()
        record = find_idempotency(
            db,
            agent_api_key_id=build.agent_api_key_id,
            action=IDEMPOTENCY_BUILD,
            idempotency_key=build.idempotency_key or "",
        )
        if record is not None:
            db.delete(record)
        upload = db.get(AgentMonthlyReportUpload, build.upload_id)
        if upload is not None:
            refresh_upload_status(db, upload)
        db.commit()
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_DISPATCH_FAILED,
            human_message="月报计算任务派发失败，请稍后重试",
            agent_hint="用同一 Idempotency-Key 重试 POST /builds（失败任务不占用该 key）",
        ) from exc
    build.celery_task_id = task_id
    db.commit()
    return build


def claim_queued_build(db: Session, build_id: int) -> bool:
    """数据库原子领取：只有把 queued 改成 running 的那次调用会执行。"""
    result = db.execute(
        update(AgentMonthlyReportBuild)
        .where(
            AgentMonthlyReportBuild.id == build_id,
            AgentMonthlyReportBuild.status == AgentMonthlyReportBuildStatus.queued.value,
        )
        .values(
            status=AgentMonthlyReportBuildStatus.running.value,
            started_at=utc_now(),
            attempt_count=AgentMonthlyReportBuild.attempt_count + 1,
        )
    )
    db.commit()
    return bool(result.rowcount)


def execute_build(db: Session, settings: Settings, build_id: int) -> dict:
    """执行一次仅计算草稿（由 celery 任务调用；不含权限/确认）。"""
    build = db.get(AgentMonthlyReportBuild, build_id)
    if build is None:
        return {"status": "missing"}
    if build.status != AgentMonthlyReportBuildStatus.running.value:
        return {"status": "skipped", "build_status": build.status}

    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    transaction_file = db.execute(
        select(AgentMonthlyReportFile).where(
            AgentMonthlyReportFile.upload_id == build.upload_id,
            AgentMonthlyReportFile.kind == CSV_KIND,
        )
    ).scalar_one_or_none()
    if upload is None or transaction_file is None:
        _mark_failed(db, build, "input_missing")
        return {"status": "failed", "reason": "input_missing"}

    output_dir = build_dir(settings, build.id)
    try:
        artifacts = build_preview(
            transaction_path=Path(transaction_file.stored_path),
            output_dir=output_dir,
            project_name=upload.project_name,
            country=upload.country,
            report_month=upload.report_month,
            expected_input_sha256=build.input_sha256,
        )
    except PreviewIntegrityError as exc:
        _mark_failed(db, build, f"integrity: {exc}")
        return {"status": "failed", "reason": "integrity"}
    except (Exception, SoftTimeLimitExceeded) as exc:  # noqa: BLE001
        logger.exception("agent monthly report build %s failed", build.id)
        _mark_failed(db, build, f"{type(exc).__name__}: {exc}")
        remove_tree_best_effort(output_dir)
        return {"status": "failed", "reason": "calculation"}

    build.status = AgentMonthlyReportBuildStatus.success.value
    build.error_message = None
    build.result_dir = str(artifacts.payload_path.parent)
    build.payload_path = str(artifacts.payload_path)
    build.payload_sha256 = artifacts.payload_sha256
    build.workbook_path = str(artifacts.workbook_path)
    build.workbook_sha256 = artifacts.workbook_sha256
    build.calculation_version = artifacts.calculation_version
    build.finished_at = utc_now()
    refresh_upload_status(db, upload)
    db.commit()
    return {"status": "success", "build_id": build.id}


def _mark_failed(db: Session, build: AgentMonthlyReportBuild, reason: str) -> None:
    build.status = AgentMonthlyReportBuildStatus.failed.value
    # 不回传原始异常堆栈给 Agent：只留简短原因（契约要求）。
    build.error_message = reason[:4000]
    build.finished_at = utc_now()
    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    if upload is not None:
        refresh_upload_status(db, upload)
    db.commit()


def artifacts_for(build: AgentMonthlyReportBuild) -> PreviewArtifacts:
    """把 build 行还原成 A 的可校验产物句柄（不重算）。"""
    if (
        build.payload_path is None
        or build.payload_sha256 is None
        or build.workbook_path is None
        or build.workbook_sha256 is None
    ):
        raise PreviewIntegrityError("build artifacts missing")
    return PreviewArtifacts(
        payload_path=Path(build.payload_path),
        payload_sha256=build.payload_sha256,
        workbook_path=Path(build.workbook_path),
        workbook_sha256=build.workbook_sha256,
        input_sha256=build.input_sha256,
        calculation_version=build.calculation_version or CALCULATION_VERSION,
    )


def assert_build_ready(db: Session, build: AgentMonthlyReportBuild) -> None:
    """确认/预览/下载前的统一门：成功 + 未过期。"""
    assert_not_expired(build)
    if build.status != AgentMonthlyReportBuildStatus.success.value:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_NOT_READY,
            human_message=f"草稿状态为 {build.status}，尚不可用",
            agent_hint="轮询 GET /builds/{build_id} 直到 status=success",
        )


def load_build_preview(build: AgentMonthlyReportBuild) -> dict:
    """读取草稿并校验完整性；损坏/缺失一律 fail closed。"""
    try:
        return load_preview(artifacts_for(build))
    except PreviewIntegrityError as exc:
        # reason 只带我们自己写死的诊断短句（含 pt3/pt4 段与 key，不含路径与
        # 用户数据），便于 Agent/运维定位是输入漂移还是内核指标类型变化。
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_NOT_READY,
            reason=str(exc)[:120],
            human_message="草稿结果损坏或不可用",
            agent_hint="请重新发起 build；若持续出现请联系管理员",
        ) from exc


def load_build_result(build: AgentMonthlyReportBuild) -> tuple[Path, str]:
    """下载前校验 XLSX 摘要，返回 (路径, 摘要)。"""
    artifacts = artifacts_for(build)
    path = artifacts.workbook_path
    try:
        if not path.is_file() or sha256_file(path) != artifacts.workbook_sha256:
            raise PreviewIntegrityError("workbook changed")
    except (OSError, PreviewIntegrityError) as exc:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_NOT_READY,
            reason=str(exc)[:120],
            human_message="草稿文件损坏或不可用",
            agent_hint="请重新发起 build",
        ) from exc
    return path, artifacts.workbook_sha256


def existing_success_report(
    db: Session, *, project_id: int, country: str, report_month: str
) -> int | None:
    """同项目+国家+月份是否已有成功月报（含非 current 的历史版本）。"""
    from app.models import MonthlyReport
    from app.models.job import JobStatus

    row = db.execute(
        select(MonthlyReport.id)
        .where(
            MonthlyReport.project_id == project_id,
            MonthlyReport.country == country,
            MonthlyReport.report_month == report_month,
            MonthlyReport.status == JobStatus.success,
        )
        .order_by(MonthlyReport.id.asc())
        .limit(1)
    ).scalar_one_or_none()
    return int(row) if row is not None else None


def build_status_payload(
    db: Session, build: AgentMonthlyReportBuild, upload: AgentMonthlyReportUpload
) -> dict:
    """状态端点响应（不含服务器路径/原始堆栈）。"""
    conflict_report_id = None
    if build.status == AgentMonthlyReportBuildStatus.success.value:
        conflict_report_id = existing_success_report(
            db,
            project_id=upload.project_id,
            country=upload.country,
            report_month=upload.report_month,
        )
    return {
        "build_id": build.id,
        "upload_id": build.upload_id,
        "status": build.status,
        "project_id": upload.project_id,
        "project_name": upload.project_name,
        "country": upload.country,
        "report_month": upload.report_month,
        "input_sha256": build.input_sha256,
        "calculation_version": build.calculation_version,
        "report_id": build.report_id,
        "confirmed_at": build.confirmed_at.isoformat() if build.confirmed_at else None,
        "error_message": (
            build.error_message
            if build.status == AgentMonthlyReportBuildStatus.failed.value
            else None
        ),
        "expires_at": build.expires_at.astimezone(UTC).isoformat(),
        "existing_success_report_id": conflict_report_id,
        "created_at": build.created_at.astimezone(UTC).isoformat(),
        "updated_at": build.updated_at.astimezone(UTC).isoformat(),
    }


def preview_payload(
    build: AgentMonthlyReportBuild, upload: AgentMonthlyReportUpload, result: dict
) -> dict:
    """预览端点响应：授权范围内的汇总指标 + 输入摘要 + 版本预条件。"""
    transactions = result.get("transactions") or []
    return {
        "build_id": build.id,
        "project_id": upload.project_id,
        "project_name": upload.project_name,
        "country": upload.country,
        "report_month": upload.report_month,
        "input_sha256": build.input_sha256,
        "calculation_version": build.calculation_version,
        "transactions_count": len(transactions),
        # 十进制字符串，避免浮点误差（与增量 A 的落盘口径一致）。
        "pt3": {key: str(value) for key, value in (result.get("pt3") or {}).items()},
        "pt4": {key: str(value) for key, value in (result.get("pt4") or {}).items()},
        "expires_at": build.expires_at.astimezone(UTC).isoformat(),
        "requires_confirmation": True,
    }


__all__ = [
    "artifacts_for",
    "assert_build_ready",
    "build_status_payload",
    "claim_queued_build",
    "dispatch_build",
    "enqueue_build",
    "execute_build",
    "existing_success_report",
    "load_build_preview",
    "load_build_result",
    "preview_payload",
    "start_build",
]

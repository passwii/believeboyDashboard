"""Agent 月报：确认入库、并发串行化与补偿（BLF-1250 阶段一，技术单元 C）。

confirm 的语义（契约 §状态、权限与一致性）：

* **不重算**：绑定 build 的输入/结果摘要，确认时只校验完整性 + 期限 + 权限；
* **两步 + 数据库幂等**：首次返回 ``requires_confirmation`` 壳与 Redis 单次
  token；重放（带 token）执行入库。响应丢失后的重试靠
  ``agent_monthly_report_idempotency`` 的 ``(agent key, 'confirm', key)`` 唯一行
  返回原 ``report_id``，不新增版本——不能只依赖被原子 pop 的 Redis token；
* **同月策略**：项目+国家+月份已有成功月报（含非 current 历史版本）时拒绝；
  为防「先查再写」竞态，锁内还会拒绝仍在 pending/running 的同键报告（否则
  Agent 会把 dashboard 的在途报告挤下 current）；
* **补偿**：正式文件晋升在 DB 事务之前，事务失败撤销本次晋升；事务已提交则
  绝不因后续响应/清理失败删除正式文件。
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from fastapi import Request
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.core.config import Settings
from app.models import MonthlyReport
from app.models.agent_monthly_report import (
    AgentMonthlyReportBuild,
    AgentMonthlyReportFile,
    AgentMonthlyReportUpload,
    AgentMonthlyReportUploadStatus,
)
from app.models.job import JobStatus
from app.services import upload_service
from app.services.agent_monthly_report_common import (
    CSV_KIND,
    IDEMPOTENCY_CONFIRM,
    PDF_KIND,
    assert_not_expired,
    assert_same_request,
    canonical_request_hash,
    find_idempotency,
    record_idempotency,
    utc_now,
)
from app.services.agent_monthly_report_build_service import (
    assert_build_ready,
    load_build_preview,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services.report.monthly import (
    lock_monthly_report_key,
    persist_monthly_report_result,
    prepare_monthly_report,
)

logger = logging.getLogger(__name__)

#: 同键阻塞状态：成功报告（确认规则）+ 在途报告（避免挤掉 dashboard 的 current）。
_BLOCKING_STATUSES = (JobStatus.pending, JobStatus.running, JobStatus.success)


def confirm_request_hash(build_id: int, body: bytes) -> str:
    """confirm 的请求指纹：必须含 build_id（路径参数），否则同一幂等键会在不同
    build 之间被误判为「同请求」并静默复用旧 report_id。"""
    return canonical_request_hash(
        {"build_id": build_id, "body_sha256": canonical_request_hash({"raw": body.decode("utf-8", "ignore")})}
    )


def blocking_report(
    db: Session, *, project_id: int, country: str, report_month: str
) -> MonthlyReport | None:
    """锁内检查同键是否已有阻塞报告（成功或在途，含非 current 历史版本）。"""
    return db.query(MonthlyReport).filter(
        MonthlyReport.project_id == project_id,
        MonthlyReport.country == country,
        MonthlyReport.report_month == report_month,
        MonthlyReport.status.in_(_BLOCKING_STATUSES),
    ).order_by(MonthlyReport.id.asc()).first()


def confirmation_preview(
    db: Session, *, build: AgentMonthlyReportBuild, upload: AgentMonthlyReportUpload
) -> dict:
    """确认前的摘要：Agent 据此向用户复述（不含服务器路径）。"""
    result = load_build_preview(build)
    blocking = blocking_report(
        db,
        project_id=upload.project_id,
        country=upload.country,
        report_month=upload.report_month,
    )
    return {
        "build_id": build.id,
        "project_id": upload.project_id,
        "project_name": upload.project_name,
        "country": upload.country,
        "report_month": upload.report_month,
        "transactions_count": len(result.get("transactions") or []),
        "input_sha256": build.input_sha256,
        "summary_pdf_included": build.summary_pdf_sha256 is not None,
        "calculation_version": build.calculation_version,
        "existing_report_id": blocking.id if blocking is not None else None,
        "existing_report_status": (
            blocking.status.value if blocking is not None else None
        ),
        "will_conflict": blocking is not None,
        "expires_at": build.expires_at.isoformat(),
    }


def _promote(
    settings: Settings,
    *,
    upload: AgentMonthlyReportUpload,
    build: AgentMonthlyReportBuild,
    transaction_file: AgentMonthlyReportFile,
    summary_pdf: AgentMonthlyReportFile | None,
    workbook_path: Path,
) -> dict:
    """把临时件复制为正式件（本地正式目录）；返回路径与补偿清单。

    阶段一晋升目标 = 本地正式目录（``upload_root`` / ``result_root``）：dashboard
    的读取路径（``build_upload_file_path`` / ``resolve_result_path``）就是本地
    文件，复制到该布局即与既有流程一致；对象存储（R2）晋升不在阶段一范围。
    """
    created: list[Path] = []
    try:
        transaction_id = f"agent-{build.id}-{build.input_sha256[:12]}.csv"
        transaction_path = upload_service.build_upload_file_path(
            settings, upload.project_name, "payment_report", transaction_id
        )
        transaction_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(transaction_file.stored_path, transaction_path)
        created.append(transaction_path)

        summary_pdf_id = None
        summary_pdf_path = None
        if summary_pdf is not None:
            summary_pdf_id = f"agent-{build.id}-{(build.summary_pdf_sha256 or '')[:12]}.pdf"
            summary_pdf_path = upload_service.build_upload_file_path(
                settings, upload.project_name, "monthly_summary_pdf", summary_pdf_id
            )
            summary_pdf_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(summary_pdf.stored_path, summary_pdf_path)
            created.append(summary_pdf_path)

        result_dir = settings.result_root / f"agent-monthly-report-{build.id}"
        result_dir.mkdir(parents=True, exist_ok=True)
        result_path = result_dir / workbook_path.name
        shutil.copyfile(workbook_path, result_path)
        created.append(result_path)
    except BaseException:
        for path in reversed(created):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.exception("failed to undo promotion of %s", path)
        raise

    return {
        "transaction_file_id": transaction_id,
        "transaction_file_path": str(transaction_path),
        "summary_pdf_file_id": summary_pdf_id,
        "summary_pdf_file_path": (
            str(summary_pdf_path) if summary_pdf_path is not None else None
        ),
        "result_path": str(result_path),
        "created": created,
    }


def _undo_promotion(created: list[Path]) -> None:
    """DB 未提交时撤销本次晋升（已提交则绝不调用）。"""
    for path in reversed(created):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.exception("failed to compensate promoted file %s", path)
    parent_dirs = {path.parent for path in created}
    for directory in parent_dirs:
        try:
            if directory.is_dir() and not any(directory.iterdir()):
                directory.rmdir()
        except OSError:
            logger.warning("failed to remove empty formal dir %s", directory)


def perform_confirm(
    db: Session,
    settings: Settings,
    *,
    build: AgentMonthlyReportBuild,
    upload: AgentMonthlyReportUpload,
    idempotency_key: str,
    request_hash: str,
    request: Request | None = None,
    agent_name: str | None = None,
) -> dict:
    """执行确认入库；返回响应体（含 report_id）。"""
    existing = find_idempotency(
        db,
        agent_api_key_id=build.agent_api_key_id,
        action=IDEMPOTENCY_CONFIRM,
        idempotency_key=idempotency_key,
    )
    if existing is not None:
        assert_same_request(existing, request_hash)
        return _confirmed_payload(db, build, report_id=existing.report_id, replayed=True)

    assert_not_expired(build)
    assert_build_ready(db, build)
    # 完整性 fail closed：结果/输入被篡改或缺失时不得入库。
    result = load_build_preview(build)

    transaction_file = db.query(AgentMonthlyReportFile).filter(
        AgentMonthlyReportFile.upload_id == upload.id,
        AgentMonthlyReportFile.kind == CSV_KIND,
    ).one_or_none()
    if transaction_file is None:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_NOT_READY,
            human_message="交易文件缺失",
            agent_hint="请新建上传会话与 build 后重试",
        )
    summary_pdf = db.query(AgentMonthlyReportFile).filter(
        AgentMonthlyReportFile.upload_id == upload.id,
        AgentMonthlyReportFile.kind == PDF_KIND,
    ).one_or_none()

    workbook_path = Path(build.workbook_path or "")
    if not workbook_path.is_file():
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_NOT_READY,
            human_message="草稿文件缺失",
            agent_hint="请重新发起 build",
        )

    # 目标键锁：与 dashboard 的 prepare/persist 共用一把 advisory lock。
    lock_monthly_report_key(
        db,
        project_id=upload.project_id,
        country=upload.country,
        report_month=upload.report_month,
    )
    blocking = blocking_report(
        db,
        project_id=upload.project_id,
        country=upload.country,
        report_month=upload.report_month,
    )
    if blocking is not None:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_CONFLICT,
            human_message=(
                f"该项目/国家/月份已有月报（id={blocking.id}, "
                f"status={blocking.status.value}），阶段一不自动替换当前版本"
            ),
            agent_hint="如需新版本，请在 dashboard 侧处理；Agent 确认被拒绝不产生任何正式写入",
        )

    try:
        promoted = _promote(
            settings,
            upload=upload,
            build=build,
            transaction_file=transaction_file,
            summary_pdf=summary_pdf,
            workbook_path=workbook_path,
        )
    except AgentApiError:
        raise
    except OSError as exc:
        # 晋升失败：_promote 已撤销本次已写入的文件，正式表未被触碰。
        logger.exception("agent monthly report promotion failed")
        raise AgentApiError(
            ErrorCode.INTERNAL_ERROR,
            human_message="正式文件晋升失败，未产生任何正式写入",
            agent_hint="草稿仍在 24 小时临时期限内，可直接重新发起确认",
        ) from exc
    committed = False
    try:
        report = prepare_monthly_report(
            db,
            project_id=upload.project_id,
            project_name=upload.project_name,
            country=upload.country,
            report_month=upload.report_month,
            transaction_file_id=promoted["transaction_file_id"],
            transaction_file_path=promoted["transaction_file_path"],
            summary_pdf_file_id=promoted["summary_pdf_file_id"],
            summary_pdf_file_path=promoted["summary_pdf_file_path"],
            file_size=transaction_file.size_bytes,
        )
        # 结果里的 result_path 指向临时草稿目录（janitor 会清理）——正式入库必须
        # 指向晋升后的正式文件。
        persist_monthly_report_result(
            db,
            report_id=report.id,
            result={**result, "result_path": promoted["result_path"]},
            calculation_version=build.calculation_version or 1,
        )
        build.confirmed_at = utc_now()
        build.report_id = report.id
        build.confirm_idempotency_key = idempotency_key
        upload.status = AgentMonthlyReportUploadStatus.confirmed.value
        record_idempotency(
            db,
            agent_api_key_id=build.agent_api_key_id,
            action=IDEMPOTENCY_CONFIRM,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            build_id=build.id,
            report_id=report.id,
        )
        append_operation_audit_log(
            db,
            action="agent_monthly_reports.confirm",
            target_type="monthly_report",
            target_id=report.id,
            result="success",
            after={
                "build_id": build.id,
                "upload_id": upload.id,
                "project_id": upload.project_id,
                "project_name": upload.project_name,
                "country": upload.country,
                "report_month": upload.report_month,
                "input_sha256": build.input_sha256,
                "result_sha256": build.workbook_sha256,
                "report_id": report.id,
            },
            request=request,
            agent_id=build.agent_id,
            agent_name=agent_name,
            idempotency_key=idempotency_key,
        )
        db.commit()
        committed = True
    except AgentApiError:
        db.rollback()
        if not committed:
            _undo_promotion(promoted["created"])
        raise
    except BaseException as exc:
        db.rollback()
        if not committed:
            _undo_promotion(promoted["created"])
        logger.exception("agent monthly report persist failed")
        raise AgentApiError(
            ErrorCode.INTERNAL_ERROR,
            human_message="月报入库失败，未产生正式写入",
            agent_hint="草稿仍在 24 小时临时期限内，可直接重新发起确认",
        ) from exc

    return _confirmed_payload(db, build, report_id=build.report_id, replayed=False)


def _confirmed_payload(
    db: Session,
    build: AgentMonthlyReportBuild,
    *,
    report_id: int | None,
    replayed: bool,
) -> dict:
    report = db.get(MonthlyReport, report_id) if report_id else None
    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    return {
        "build_id": build.id,
        "report_id": report_id,
        "replayed": replayed,
        "project_id": report.project_id if report else (upload.project_id if upload else None),
        "project_name": report.project_name if report else (upload.project_name if upload else None),
        "country": report.country if report else (upload.country if upload else None),
        "report_month": report.report_month if report else (upload.report_month if upload else None),
        "version": report.version if report else None,
        "is_current": report.is_current if report else None,
        "status": report.status.value if report else None,
        "confirmed_at": (
            report.computed_at.isoformat()
            if report and report.computed_at
            else (build.confirmed_at.isoformat() if build.confirmed_at else None)
        ),
        "human_message": "月报已正式入库（阶段一不自动替换已有成功月报）",
    }


__all__ = [
    "blocking_report",
    "confirm_request_hash",
    "confirmation_preview",
    "perform_confirm",
]

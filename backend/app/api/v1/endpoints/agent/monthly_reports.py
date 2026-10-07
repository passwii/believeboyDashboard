"""Agent 月报写入域路由（BLF-1250 阶段一）。

``/api/v1/agent/monthly-reports/*`` 提供契约里的 7 条路由：

* ``POST /uploads`` —— 建临时上传会话（project_id/country/report_month）；
* ``POST /uploads/{upload_id}/files`` —— multipart 原始二进制上传（CSV 必选、
  PDF 可选），**按流累计字节**拦截 50 MiB，不返回服务器路径；
* ``POST /builds`` —— 发起仅计算草稿（202 + build_id）；
* ``GET /builds/{build_id}`` —— 状态（queued/running/success/failed/expired）；
* ``GET /builds/{build_id}/preview`` —— 授权范围内的指标/行数/输入摘要/版本预条件；
* ``GET /builds/{build_id}/result`` —— 下载草稿 XLSX（私有，权限不绕过）；
* ``POST /builds/{build_id}/confirm`` —— 两步确认 + 正式入库（幂等 + 数据库锁）。

装配约定（``agent/__init__.py``）：

* 鉴权由 ``agent_router`` 级 ``require_agent_credential`` 承担（agent 通道不挂
  内部 dashboard 的 ``protected``）；
* 域门禁 ``require_business_scope("monthly_reports")`` 在 include_router 时挂载；
* 每一步在 handler 内重查 ``project_scope``（撤销后立即拒绝查询/下载/确认），
  并按 agent key 归属解析资源——跨凭据一律 404（不泄漏存在性）；
* 写路由（建会话/上传/建 build/confirm）挂写限流。

阶段一不自动替换已有成功月报：confirm 在同月已有阻塞报告时返回 409，且不产生
任何正式写入（契约 §已确认产品规则 4）。
"""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile as StarletteUploadFile
from starlette.formparsers import MultiPartParser

from app.api.agent.confirm import (
    ConfirmReplayError,
    consume_confirm_token,
    issue_confirm_token,
)
from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.file_response import agent_file_response
from app.api.agent.rate_limit import require_agent_write_rate_limit
from app.api.agent.response import agent_ok
from app.api.deps import get_primary_db_session, get_read_db_session
from app.core.config import Settings, get_settings
from app.models.agent_monthly_report import AgentMonthlyReportUpload
from app.models.job import JobStatus
from app.schemas.agent_monthly_report import (
    AgentMonthlyReportDetail,
    AgentMonthlyReportListItem,
    MonthlyFinancialAccountingDetailEnvelope,
    MonthlyFinancialSeriesEnvelope,
    MonthlyReportBuildCreateRequest,
    MonthlyReportDetailEnvelope,
    MonthlyReportListEnvelope,
    MonthlyReportUploadCreateRequest,
)
from app.services import agent_monthly_report_upload_service as upload_service
from app.services.agent_monthly_report_build_service import (
    build_status_payload,
    enqueue_build,
    load_build_preview,
    load_build_result,
    preview_payload,
    start_build,
)
from app.services.agent_monthly_report_common import (
    CHUNK_SIZE,
    IDEMPOTENCY_CONFIRM,
    MULTIPART_FRAMING_SLACK,
    assert_not_expired,
    assert_project_scope,
    assert_same_request,
    canonical_request_hash,
    find_idempotency,
    owned_build_or_404,
    owned_upload_or_404,
    prepare_private_dir,
    require_idempotency_key,
)
from app.services.agent_monthly_report_confirm_service import (
    confirm_request_hash,
    confirmation_preview,
    perform_confirm,
)
from app.services.audit_log_service import append_operation_audit_log
from app.services.report.export import export_financial_accounting_detail_workbook
from app.services.report.monthly import (
    get_financial_accounting_detail,
    get_financial_series,
    get_report_detail,
    get_report_or_404,
    list_reports,
    parse_report_month,
    resolve_result_path,
)
from app.utils.country import normalize_country

logger = logging.getLogger(__name__)

monthly_reports_router = APIRouter(
    prefix="/monthly-reports",
    tags=["agent-monthly-reports"],
)

CONFIRM_ACTION = "monthly_reports.confirm"


@contextmanager
def _read_service_errors():
    """Translate internal monthly-report service errors into the Agent JSON shell."""
    try:
        yield
    except AgentApiError:
        raise
    except ValueError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message=str(exc)
        ) from None
    except Exception as exc:
        from fastapi import HTTPException

        if isinstance(exc, HTTPException):
            code = (
                ErrorCode.RESOURCE_NOT_FOUND
                if exc.status_code == 404
                else ErrorCode.MONTHLY_REPORT_NOT_READY
                if exc.status_code == 409
                else ErrorCode.AGENT_RATE_LIMIT_EXCEEDED
                if exc.status_code == 429
                else ErrorCode.VALIDATION_FAILED
            )
            raise AgentApiError(code, human_message=str(exc.detail)) from None
        raise


def _monthly_report_list_item(report) -> AgentMonthlyReportListItem:
    """Match the dashboard report fields without disclosing storage locations."""
    return AgentMonthlyReportListItem(
        id=report.id,
        project_id=report.project_id,
        project_name=report.project_name,
        country=report.country,
        report_month=report.report_month,
        version=report.version,
        is_current=report.is_current,
        superseded_at=report.superseded_at,
        status=report.status,
        settlement_id=report.settlement_id,
        total_transactions=report.total_transactions,
        total_orders=report.total_orders,
        total_refunds=report.total_refunds,
        total_adjustments=report.total_adjustments,
        total_service_fees=report.total_service_fees,
        total_trans_fees=report.total_trans_fees,
        # Preserve dashboard fields without leaking server-local storage paths.
        result_file_path=None,
        error_message=None,
        calculation_version=report.calculation_version,
        computed_at=report.computed_at,
        created_at=report.created_at,
        updated_at=report.updated_at,
    )


def _serialize_calculation_row(row) -> dict[str, float] | None:
    if row is None:
        return None
    excluded = {
        "id",
        "report_id",
        "project_name",
        "report_month",
        "calculation_version",
        "computed_at",
        "created_at",
        "updated_at",
    }
    return {
        column.name: float(value) if value is not None else 0.0
        for column in row.__table__.columns
        if column.name not in excluded
        for value in (getattr(row, column.name),)
    }


def _require_project_read_scope(project_id: int, request: Request) -> None:
    """Recheck project_scope on every read, including project-filtered queries."""
    assert_project_scope(project_id, request)


def _normalize_read_filters(country: str | None, month: str | None):
    try:
        normalized_country = normalize_country(country) if country is not None else None
        normalized_month = parse_report_month(month) if month is not None else None
    except ValueError as exc:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED, human_message=str(exc)
        ) from None
    return normalized_country, normalized_month

_XLSX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
)
_XLSX_BINARY_RESPONSE = {
    200: {
        "description": "XLSX 文件流",
        "content": {
            _XLSX_MEDIA_TYPE: {
                "schema": {"type": "string", "format": "binary"}
            }
        },
    }
}


def _key_id(request: Request) -> int:
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        # 依赖顺序错误（auth 未先跑）→ fail closed。
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
    return int(key_id)


def _agent_id(request: Request) -> str:
    return getattr(request.state, "agent_id", "") or ""


def _audit_kwargs(request: Request, idempotency_key: str | None = None) -> dict:
    return {
        "request": request,
        "agent_id": _agent_id(request) or None,
        "agent_name": getattr(request.state, "agent_label", None),
        "idempotency_key": idempotency_key,
    }


# ── 月报读取（与 dashboard 共用 service 与 response schema） ─────────────


@monthly_reports_router.get("", response_model=MonthlyReportListEnvelope)
def list_agent_monthly_reports(
    request: Request,
    project_id: int = Query(gt=0),
    country: str | None = Query(default=None),
    month: str | None = Query(default=None),
    include_history: bool = Query(default=False),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """按项目列出月报；默认仅当前版本，include_history 可查看历史版本。"""
    _require_project_read_scope(project_id, request)
    with _read_service_errors():
        normalized_country, normalized_month = _normalize_read_filters(country, month)
        rows = list_reports(
            db,
            project_id=project_id,
            country=normalized_country,
            report_month=normalized_month,
            current_only=not include_history,
        )
    return agent_ok([_monthly_report_list_item(row) for row in rows])


@monthly_reports_router.get(
    "/financial-series", response_model=MonthlyFinancialSeriesEnvelope
)
def get_agent_monthly_financial_series(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    start_month: str | None = Query(default=None),
    end_month: str | None = Query(default=None),
    fill_missing: bool = Query(default=True),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """月度财务序列与趋势，复用 dashboard 财务口径。"""
    _require_project_read_scope(project_id, request)
    with _read_service_errors():
        normalized_country = normalize_country(country)
        if start_month is not None:
            parse_report_month(start_month)
        if end_month is not None:
            parse_report_month(end_month)
        payload = get_financial_series(
            db,
            project_id=project_id,
            country=normalized_country,
            start_month=start_month,
            end_month=end_month,
            fill_missing=fill_missing,
        )
    return agent_ok(payload)


@monthly_reports_router.get(
    "/financial-series/accounting-detail",
    response_model=MonthlyFinancialAccountingDetailEnvelope,
)
def get_agent_monthly_accounting_detail(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    report_month: str = Query(min_length=7, max_length=7),
    db: Session = Depends(get_read_db_session),
) -> dict:
    """指定月份的核算明细，字段/币种/行结构复用 dashboard service。"""
    _require_project_read_scope(project_id, request)
    with _read_service_errors():
        normalized_country = normalize_country(country)
        parse_report_month(report_month)
        payload = get_financial_accounting_detail(
            db,
            project_id=project_id,
            country=normalized_country,
            report_month=report_month,
        )
    return agent_ok(payload)


@monthly_reports_router.get(
    "/financial-series/accounting-detail/export",
    response_class=StreamingResponse,
    response_model=None,
    responses=_XLSX_BINARY_RESPONSE,
)
def export_agent_monthly_accounting_detail(
    request: Request,
    project_id: int = Query(gt=0),
    country: str = Query(default="US"),
    report_month: str = Query(min_length=7, max_length=7),
    db: Session = Depends(get_primary_db_session),
) -> StreamingResponse:
    """导出与 dashboard 完全一致的核算明细 XLSX 二进制流。"""
    _require_project_read_scope(project_id, request)
    with _read_service_errors():
        normalized_country = normalize_country(country)
        parse_report_month(report_month)
        filename, content = export_financial_accounting_detail_workbook(
            db,
            project_id=project_id,
            country=normalized_country,
            report_month=report_month,
            is_admin=False,
        )
    append_operation_audit_log(
        db,
        action="agent_monthly_reports.accounting_detail.export",
        target_type="monthly_report_project",
        target_id=project_id,
        after={
            "project_id": project_id,
            "country": normalized_country,
            "report_month": report_month,
        },
        **_audit_kwargs(request),
    )
    db.commit()
    return agent_file_response(
        content, filename=filename, media_type=_XLSX_MEDIA_TYPE
    )


@monthly_reports_router.get(
    "/{report_id:int}", response_model=MonthlyReportDetailEnvelope
)
def get_agent_monthly_report_detail(
    report_id: int,
    request: Request,
    db: Session = Depends(get_read_db_session),
) -> dict:
    """月报详情与 PT3/PT4 指标，不暴露服务端文件路径。"""
    with _read_service_errors():
        report = get_report_or_404(db, report_id)
        _require_project_read_scope(report.project_id, request)
        report, pt3, pt4 = get_report_detail(db, report_id=report_id)
    return agent_ok(
        AgentMonthlyReportDetail(
            report=_monthly_report_list_item(report),
            pt3=_serialize_calculation_row(pt3),
            pt4=_serialize_calculation_row(pt4),
        )
    )


@monthly_reports_router.get(
    "/{report_id:int}/export",
    response_class=FileResponse,
    response_model=None,
    responses=_XLSX_BINARY_RESPONSE,
)
def download_agent_monthly_report_result(
    report_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> FileResponse:
    """下载正式月报结果文件；项目权限每次重验，成功响应为原始 XLSX 二进制。"""
    with _read_service_errors():
        report = get_report_or_404(db, report_id)
        _require_project_read_scope(report.project_id, request)
        if report.status != JobStatus.success:
            raise AgentApiError(
                ErrorCode.MONTHLY_REPORT_NOT_READY,
                human_message="月报尚未成功完成，暂不可下载结果文件",
            )
        result_path = resolve_result_path(report)
        if result_path is None:
            raise AgentApiError(
                ErrorCode.RESOURCE_NOT_FOUND,
                human_message="月报结果文件不存在",
            )
    append_operation_audit_log(
        db,
        action="agent_monthly_reports.result.export",
        target_type="monthly_report",
        target_id=report.id,
        after={"report_id": report.id, "filename": result_path.name},
        **_audit_kwargs(request),
    )
    db.commit()
    return FileResponse(
        path=str(result_path), filename=result_path.name, media_type=_XLSX_MEDIA_TYPE
    )


def _audit_failure(
    db: Session,
    request: Request,
    *,
    action: str,
    target_id: int | str | None,
    error: AgentApiError,
    extra: dict | None = None,
) -> None:
    """拒绝原因落审计（契约要求）；审计写失败不影响主错误返回。"""
    try:
        append_operation_audit_log(
            db,
            action=action,
            target_type="agent_monthly_report_build",
            target_id=target_id,
            result="failure",
            after={**(extra or {}), "code": error.code.value},
            error_message=error.human_message or error.code.value,
            **_audit_kwargs(request),
        )
        db.commit()
    except Exception:  # noqa: BLE001 — 审计是旁路，绝不覆盖主错误
        logger.exception("failed to write agent monthly report failure audit")
        db.rollback()


@contextmanager
def _build_failure_audit(db: Session, request: Request, build_id: int):
    """confirm 失败的审计包装（成功路径在 confirm service 内落审计）。"""
    try:
        yield
    except AgentApiError as exc:
        _audit_failure(
            db,
            request,
            action="agent_monthly_reports.confirm",
            target_id=build_id,
            error=exc,
            extra={"build_id": build_id},
        )
        raise


# ── 上传会话 ────────────────────────────────────────────────────────────


@monthly_reports_router.post(
    "/uploads", dependencies=[Depends(require_agent_write_rate_limit)]
)
def create_upload_session(
    request: Request,
    payload: MonthlyReportUploadCreateRequest,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    """建临时上传会话（不写正式财务表）。"""
    key_id = _key_id(request)
    assert_project_scope(payload.project_id, request)
    upload = upload_service.create_session(
        db,
        settings,
        agent_api_key_id=key_id,
        agent_id=_agent_id(request),
        project_id=payload.project_id,
        country=payload.country,
        report_month=payload.report_month,
    )
    append_operation_audit_log(
        db,
        action="agent_monthly_reports.upload.create",
        target_type="agent_monthly_report_upload",
        target_id=upload.id,
        after={
            "upload_id": upload.id,
            "project_id": upload.project_id,
            "country": upload.country,
            "report_month": upload.report_month,
        },
        **_audit_kwargs(request),
    )
    db.commit()
    return agent_ok(
        {
            "upload_id": upload.id,
            "project_id": upload.project_id,
            "project_name": upload.project_name,
            "country": upload.country,
            "report_month": upload.report_month,
            "status": upload.status,
            "expires_at": upload.expires_at.isoformat(),
            "max_file_bytes": settings.agent_monthly_report_max_bytes,
            "allowed_kinds": ["transaction_csv", "summary_pdf"],
        }
    )


# ── 原始二进制上传 ──────────────────────────────────────────────────────


async def _iter_file(path: Path, chunk_size: int = CHUNK_SIZE):
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(chunk_size)
            if not chunk:
                break
            yield chunk


async def _spool_capped_body(request: Request, settings: Settings) -> Path:
    """把请求体流式落到私有临时文件，按累计字节拦截（不信 Content-Length）。"""
    limit = settings.agent_monthly_report_max_bytes + MULTIPART_FRAMING_SLACK
    tmp_dir = prepare_private_dir(settings.agent_monthly_report_root / "tmp")
    path = tmp_dir / f"body-{uuid.uuid4().hex}"
    written = 0
    try:
        with path.open("wb") as target:
            path.chmod(0o600)
            async for chunk in request.stream():
                written += len(chunk)
                if written > limit:
                    raise AgentApiError(
                        ErrorCode.MONTHLY_REPORT_TOO_LARGE,
                        human_message=(
                            "上传内容超过 "
                            f"{settings.agent_monthly_report_max_bytes // (1024 * 1024)} MiB 上限"
                        ),
                        agent_hint="服务端按流累计字节校验；请压缩或拆分后重传",
                    )
                target.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    if written == 0:
        path.unlink(missing_ok=True)
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="请求体为空",
            agent_hint="以 multipart/form-data 提交 file 与 kind 字段",
        )
    return path


@monthly_reports_router.post(
    "/uploads/{upload_id}/files",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
async def upload_file(
    upload_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
) -> dict:
    """multipart 原始二进制上传：CSV（计算输入）/ PDF（可选附件）。"""
    key_id = _key_id(request)
    upload = owned_upload_or_404(db, upload_id=upload_id, agent_api_key_id=key_id)
    assert_project_scope(upload.project_id, request)
    assert_not_expired(upload)

    spooled = await _spool_capped_body(request, settings)
    try:
        try:
            parser = MultiPartParser(
                headers=request.headers, stream=_iter_file(spooled)
            )
            form = await parser.parse()
        except AgentApiError:
            raise
        except Exception as exc:  # noqa: BLE001 — 畸形 multipart 一律 400
            raise AgentApiError(
                ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
                human_message="multipart 表单解析失败",
                agent_hint="请以 multipart/form-data 提交 file 与 kind 字段",
            ) from exc

        file_part = None
        kind = ""
        for name, value in form.multi_items():
            if isinstance(value, StarletteUploadFile) and file_part is None:
                file_part = value
            elif name == "kind" and isinstance(value, str):
                kind = value
        if file_part is None:
            raise AgentApiError(
                ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
                human_message="缺少 file 字段",
                agent_hint="kind=transaction_csv 或 summary_pdf，file 为原始二进制",
            )

        row, summary = upload_service.store_file(
            db,
            settings,
            upload=upload,
            kind=kind,
            original_filename=file_part.filename,
            content_type=file_part.content_type,
            stream=file_part.file,
        )
        append_operation_audit_log(
            db,
            action="agent_monthly_reports.upload.file",
            target_type="agent_monthly_report_upload",
            target_id=upload.id,
            after={
                "upload_id": upload.id,
                "kind": row.kind,
                "file_id": row.file_id,
                "sha256": row.sha256,
                "bytes": row.size_bytes,
                **summary,
            },
            **_audit_kwargs(request),
        )
        db.commit()
        return agent_ok(
            {
                "upload_id": upload.id,
                "file_id": row.file_id,
                "kind": row.kind,
                "original_filename": row.original_filename,
                "sha256": row.sha256,
                "bytes": row.size_bytes,
                "validation": summary,
            }
        )
    finally:
        spooled.unlink(missing_ok=True)


# ── 仅计算草稿 ──────────────────────────────────────────────────────────


@monthly_reports_router.post(
    "/builds", dependencies=[Depends(require_agent_write_rate_limit)]
)
def create_build(
    request: Request,
    payload: MonthlyReportBuildCreateRequest,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    """发起仅计算草稿：202 + build_id（幂等键必填）。"""
    key_id = _key_id(request)
    idempotency_key = require_idempotency_key(request)
    upload = owned_upload_or_404(
        db, upload_id=payload.upload_id, agent_api_key_id=key_id
    )
    assert_project_scope(upload.project_id, request)

    request_hash = canonical_request_hash(
        {
            "upload_id": payload.upload_id,
            "transaction_file_id": payload.transaction_file_id,
            "summary_pdf_file_id": payload.summary_pdf_file_id,
        }
    )
    build, replayed = start_build(
        db,
        settings,
        upload=upload,
        transaction_file_id=payload.transaction_file_id,
        summary_pdf_file_id=payload.summary_pdf_file_id,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
    )
    if not replayed:
        append_operation_audit_log(
            db,
            action="agent_monthly_reports.build",
            target_type="agent_monthly_report_build",
            target_id=build.id,
            after={
                "build_id": build.id,
                "upload_id": upload.id,
                "project_id": upload.project_id,
                "country": upload.country,
                "report_month": upload.report_month,
                "input_sha256": build.input_sha256,
            },
            **_audit_kwargs(request, idempotency_key),
        )
        db.commit()
        enqueue_build(db, build)
    else:
        db.commit()

    body = agent_ok(
        build_status_payload(db, build, upload),
        idempotency_key=idempotency_key,
        replayed=replayed,
        status_endpoint=f"/api/v1/agent/monthly-reports/builds/{build.id}",
    )
    return JSONResponse(status_code=202 if not replayed else 200, content=body)


@monthly_reports_router.get("/builds/{build_id}")
def get_build(
    build_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """状态查询：queued/running/success/failed/expired（不含服务器路径）。"""
    key_id = _key_id(request)
    build = owned_build_or_404(db, build_id=build_id, agent_api_key_id=key_id)
    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    if upload is None:
        raise AgentApiError(ErrorCode.RESOURCE_NOT_FOUND)
    assert_project_scope(upload.project_id, request)
    return agent_ok(build_status_payload(db, build, upload))


@monthly_reports_router.get("/builds/{build_id}/preview")
def get_build_preview(
    build_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> dict:
    """预览：汇总指标 + 行数 + 输入摘要 + 版本预条件（不含交易明细）。"""
    key_id = _key_id(request)
    build = owned_build_or_404(db, build_id=build_id, agent_api_key_id=key_id)
    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    if upload is None:
        raise AgentApiError(ErrorCode.RESOURCE_NOT_FOUND)
    assert_project_scope(upload.project_id, request)
    assert_not_expired(build)
    result = load_build_preview(build)
    return agent_ok(preview_payload(build, upload, result))


@monthly_reports_router.get("/builds/{build_id}/result")
def download_build_result(
    build_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
) -> FileResponse:
    """下载草稿 XLSX（私有；每次重新校验归属/权限/摘要）。"""
    key_id = _key_id(request)
    build = owned_build_or_404(db, build_id=build_id, agent_api_key_id=key_id)
    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    if upload is None:
        raise AgentApiError(ErrorCode.RESOURCE_NOT_FOUND)
    assert_project_scope(upload.project_id, request)
    assert_not_expired(build)
    path, _digest = load_build_result(build)
    append_operation_audit_log(
        db,
        action="agent_monthly_reports.result.export",
        target_type="agent_monthly_report_build",
        target_id=build.id,
        after={
            "build_id": build.id,
            "project_id": upload.project_id,
            "report_month": upload.report_month,
            "filename": path.name,
        },
        **_audit_kwargs(request),
    )
    db.commit()
    return FileResponse(
        path=str(path), filename=path.name, media_type=_XLSX_MEDIA_TYPE
    )


# ── 确认入库（两步 + 数据库幂等） ────────────────────────────────────────


@monthly_reports_router.post(
    "/builds/{build_id}/confirm",
    dependencies=[Depends(require_agent_write_rate_limit)],
)
async def confirm_build(
    build_id: int,
    request: Request,
    db: Session = Depends(get_primary_db_session),
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    """首次返回 requires_confirmation 壳 + token；重放（同 key + 同体）正式入库。

    幂等优先于 token 消费：响应丢失后同幂等键重试即使 token 已被 pop，也能拿到
    原 ``report_id``（契约要求「不新增版本」）。
    """
    key_id = _key_id(request)
    idempotency_key = require_idempotency_key(request)
    build = owned_build_or_404(db, build_id=build_id, agent_api_key_id=key_id)
    upload = db.get(AgentMonthlyReportUpload, build.upload_id)
    if upload is None:
        raise AgentApiError(ErrorCode.RESOURCE_NOT_FOUND)

    with _build_failure_audit(db, request, build_id):
        assert_project_scope(upload.project_id, request)

        body = await request.body()
        request_hash = confirm_request_hash(build_id, body)

        existing = find_idempotency(
            db,
            agent_api_key_id=key_id,
            action=IDEMPOTENCY_CONFIRM,
            idempotency_key=idempotency_key,
        )
        if existing is not None:
            assert_same_request(existing, request_hash)
            return JSONResponse(
                status_code=200,
                content=agent_ok(
                    perform_confirm(
                        db,
                        settings,
                        build=build,
                        upload=upload,
                        idempotency_key=idempotency_key,
                        request_hash=request_hash,
                        request=request,
                        agent_name=getattr(request.state, "agent_label", None),
                    ),
                    idempotency_key=idempotency_key,
                ),
            )

        confirm_header = (request.headers.get("x-confirm-token") or "").strip()
        if not confirm_header:
            assert_not_expired(build)
            preview = confirmation_preview(db, build=build, upload=upload)
            record, ttl = issue_confirm_token(
                agent_id=_agent_id(request),
                action=CONFIRM_ACTION,
                idempotency_key=idempotency_key,
                body=body,
            )
            return JSONResponse(
                status_code=200,
                content={
                    "ok": False,
                    "requires_confirmation": True,
                    "confirm_token": record.token,
                    "preview": preview,
                    "expires_in_sec": ttl,
                    "human_message": "该操作需要用户确认",
                    "agent_hint": (
                        "向用户复述 preview（项目/国家/月份/行数/是否已有月报）；"
                        "确认后用同一 Idempotency-Key + X-Confirm-Token 与完全相同的"
                        "请求体重放本接口"
                    ),
                },
            )

        try:
            consume_confirm_token(
                token=confirm_header,
                agent_id=_agent_id(request),
                idempotency_key=idempotency_key,
                body=body,
            )
        except ConfirmReplayError as exc:
            code = (
                ErrorCode.CONFIRM_TOKEN_EXPIRED
                if exc.reason == "expired"
                else ErrorCode.CONFIRM_TOKEN_INVALID
            )
            raise AgentApiError(code) from None

        payload = perform_confirm(
            db,
            settings,
            build=build,
            upload=upload,
            idempotency_key=idempotency_key,
            request_hash=request_hash,
            request=request,
            agent_name=getattr(request.state, "agent_label", None),
        )
    return JSONResponse(
        status_code=200,
        content=agent_ok(payload, idempotency_key=idempotency_key),
    )


__all__ = ["monthly_reports_router"]

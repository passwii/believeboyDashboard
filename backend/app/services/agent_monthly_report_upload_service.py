"""Agent 月报：临时上传会话与原始二进制输入（BLF-1250 阶段一，技术单元 B）。

职责边界：

* 建会话：项目名从服务端项目记录解析（不信客户端），国家/月份规范化，期限一次
  性写定 24 小时；会话只存临时状态，不写任何正式财务表；
* 存文件：按流累计字节（**不信 Content-Length**）拦截 50 MiB，服务端随机路径，
  客户端文件名只作展示；CSV 复用支付报表 parser + 项目/国家匹配校验，PDF 校验
  扩展名/MIME/文件签名且不参与计算；
* 输入不可变：每个会话一份 CSV + 可选一份 PDF，重复上传同类 → 409，更换文件
  必须新建会话（然后新建 build）。

安全边界：存储路径与摘要都是服务端可信元数据，永不回传（响应只给不透明
``file_id``）。
"""

from __future__ import annotations

import logging
import re
import uuid
from pathlib import Path
from typing import IO

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.core.config import Settings
from app.models.agent_monthly_report import (
    AgentMonthlyReportFile,
    AgentMonthlyReportFileKind,
    AgentMonthlyReportUpload,
    AgentMonthlyReportUploadStatus,
)
from app.models.project import Project
from app.services.agent_monthly_report_common import (
    CHUNK_SIZE,
    CSV_KIND,
    PDF_KIND,
    ensure_private_root,
    new_expiry,
    prepare_private_dir,
    sha256_file,
    upload_dir,
)
from app.services.report.monthly import parse_report_month
from app.utils.country import normalize_country

logger = logging.getLogger(__name__)

ALLOWED_KINDS = (CSV_KIND, PDF_KIND)
_EXTENSION_BY_KIND = {CSV_KIND: ".csv", PDF_KIND: ".pdf"}
_PDF_CONTENT_TYPES = {"application/pdf", "application/octet-stream", ""}
_CSV_CONTENT_TYPES = {
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel",
    "text/plain",
    "application/octet-stream",
    "",
}
_UNSAFE_FILENAME_RE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_PDF_MAGIC = b"%PDF-"


def _display_filename(raw: str | None) -> str:
    """客户端文件名只用于展示：剥路径分隔符与控制字符，截断到列宽。"""
    name = (raw or "").strip() or "upload.bin"
    name = _UNSAFE_FILENAME_RE.sub("-", Path(name).name)
    return (name or "upload.bin")[:255]


def create_session(
    db: Session,
    settings: Settings,
    *,
    agent_api_key_id: int,
    agent_id: str,
    project_id: int,
    country: str,
    report_month: str,
) -> AgentMonthlyReportUpload:
    """建临时上传会话（不落正式财务表）。"""
    project = db.get(Project, project_id)
    if project is None:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message=f"项目 {project_id} 不存在",
            agent_hint="GET /agent/projects 查询该凭据可见项目 id",
        )
    try:
        normalized_country = normalize_country(country)
    except ValueError as exc:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message=str(exc),
            agent_hint="country 支持 US / DE / UK（大小写不敏感）",
        ) from exc
    try:
        normalized_month = parse_report_month(report_month)
    except Exception as exc:  # HTTPException(400) from parse_report_month
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="report_month 必须是 YYYY-MM",
            agent_hint="例如 2026-09",
        ) from exc

    upload = AgentMonthlyReportUpload(
        agent_api_key_id=agent_api_key_id,
        agent_id=agent_id,
        project_id=project.id,
        # 项目名从服务端记录解析：客户端只给 id。
        project_name=project.project_name,
        country=normalized_country,
        report_month=normalized_month,
        status=AgentMonthlyReportUploadStatus.open.value,
        expires_at=new_expiry(settings),
    )
    db.add(upload)
    db.flush()
    ensure_private_root(settings)
    prepare_private_dir(upload_dir(settings, upload.id))
    return upload


def _validate_kind(kind: str) -> str:
    normalized = (kind or "").strip()
    if normalized not in ALLOWED_KINDS:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message=f"kind 必须是 {CSV_KIND} 或 {PDF_KIND}",
            agent_hint="transaction_csv 为计算输入（必传）；summary_pdf 为可选附件",
        )
    return normalized


def _validate_content_type(kind: str, content_type: str | None) -> None:
    normalized = (content_type or "").lower()
    allowed = _PDF_CONTENT_TYPES if kind == PDF_KIND else _CSV_CONTENT_TYPES
    if normalized not in allowed:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message=f"不支持的内容类型：{content_type}",
            agent_hint="CSV 用 text/csv，PDF 用 application/pdf",
        )


def _validate_csv(path: Path, *, upload: AgentMonthlyReportUpload, db: Session) -> dict:
    """复用支付报表 parser + 项目/国家匹配校验，要求有可计算行。"""
    from app.services.payment import read_payment_csv
    from app.services.payment.validation import validate_project_match

    try:
        rows = read_payment_csv(path, country=upload.country)
    except Exception as exc:  # noqa: BLE001 — 任何解析失败都是输入不合法
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="无法解析交易文件，请确认是 Amazon Payment Report CSV",
            agent_hint="需含 type/sku/quantity 等计算必需列，编码为 UTF-8/UTF-8-BOM/GBK",
        ) from exc
    if rows is None or len(rows) == 0:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="交易文件没有可计算的行",
            agent_hint="请上传包含交易明细的 Amazon Payment Report CSV",
        )

    try:
        verdict = validate_project_match(
            db,
            transaction_file_path=str(path),
            selected_project_name=upload.project_name,
            selected_country=upload.country,
        )
    except Exception as exc:  # noqa: BLE001 — 文件不存在/解析失败同样按输入不合法
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="交易文件校验失败",
            agent_hint="请重新上传完整的 Amazon Payment Report CSV",
        ) from exc
    if not verdict.get("valid", True):
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="；".join(verdict.get("errors") or ["文件校验失败"]),
            agent_hint="文件站点/SKU 必须与所选项目、国家一致",
        )
    return {
        "rows": int(len(rows)),
        "warnings": list(verdict.get("warnings") or []),
    }


def _validate_pdf(path: Path) -> dict:
    with path.open("rb") as stream:
        head = stream.read(len(_PDF_MAGIC))
    if head != _PDF_MAGIC:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="PDF 文件签名不合法（缺少 %PDF- 头）",
            agent_hint="summary_pdf 必须上传真实 PDF 二进制；PDF 不参与计算",
        )
    return {}


def store_file(
    db: Session,
    settings: Settings,
    *,
    upload: AgentMonthlyReportUpload,
    kind: str,
    original_filename: str | None,
    content_type: str | None,
    stream: IO[bytes],
) -> tuple[AgentMonthlyReportFile, dict]:
    """把原始二进制落盘为不可变输入；返回 (文件行, 校验摘要)。

    ``stream`` 是已解析的 multipart 文件流（二进制）。**字节数在这里按块累计**，
    超过上限立即 413 并删除半成品——不依赖 Content-Length。
    """
    kind = _validate_kind(kind)
    _validate_content_type(kind, content_type)

    existing = db.execute(
        select(AgentMonthlyReportFile).where(
            AgentMonthlyReportFile.upload_id == upload.id,
            AgentMonthlyReportFile.kind == kind,
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_UPLOAD_CONFLICT,
            human_message=f"该会话已上传过 {kind}",
            agent_hint="每个会话一份 CSV + 可选一份 PDF；更换文件请新建上传会话",
        )

    display_name = _display_filename(original_filename)
    extension = Path(display_name).suffix.lower()
    expected = _EXTENSION_BY_KIND[kind]
    if extension != expected:
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message=f"{kind} 需要 {expected} 文件（收到 {extension or '无扩展名'}）",
            agent_hint="CSV 为 .csv，PDF 为 .pdf；扩展名只作校验，存储路径由服务端生成",
        )

    destination = (
        upload_dir(settings, upload.id) / f"{kind}-{uuid.uuid4().hex}{expected}"
    )
    limit = settings.agent_monthly_report_max_bytes
    written = 0
    try:
        with destination.open("xb") as target:
            destination.chmod(0o600)
            while True:
                chunk = stream.read(CHUNK_SIZE)
                if not chunk:
                    break
                written += len(chunk)
                if written > limit:
                    raise AgentApiError(
                        ErrorCode.MONTHLY_REPORT_TOO_LARGE,
                        human_message=(
                            f"文件超过 {limit // (1024 * 1024)} MiB 上限"
                        ),
                        agent_hint="服务端按流累计字节校验；请压缩或拆分后重传",
                    )
                target.write(chunk)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise

    if written == 0:
        destination.unlink(missing_ok=True)
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_INVALID_INPUT,
            human_message="空文件不被接受",
            agent_hint="请上传非空的 CSV/PDF 二进制",
        )

    digest = sha256_file(destination)
    try:
        summary = (
            _validate_csv(destination, upload=upload, db=db)
            if kind == CSV_KIND
            else _validate_pdf(destination)
        )
    except BaseException:
        destination.unlink(missing_ok=True)
        raise

    row = AgentMonthlyReportFile(
        upload_id=upload.id,
        kind=kind,
        file_id=uuid.uuid4().hex,
        original_filename=display_name,
        stored_path=str(destination),
        content_type=(content_type or None),
        sha256=digest,
        size_bytes=written,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError as exc:
        # 并发上传同类文件：唯一约束 (upload_id, kind) 兜底。
        db.rollback()
        destination.unlink(missing_ok=True)
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_UPLOAD_CONFLICT,
            human_message=f"该会话已上传过 {kind}",
            agent_hint="并发上传同类文件只允许一个成功；请新建会话重试",
        ) from exc
    return row, summary

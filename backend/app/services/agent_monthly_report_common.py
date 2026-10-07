"""Agent 月报写入流程的共享边界（BLF-1250 阶段一）。

这里放三件事：

1. **存储布局与摘要**：临时上传/草稿的私有目录、SHA-256、请求体指纹；
2. **期限与归属**：24 小时期限判定、按 agent key 归属解析（跨 Agent 一律 404）；
3. **幂等台账**：``(agent_api_key_id, action, key)`` 的唯一记录 + 异体冲突。

不含业务动作（上传校验、build、confirm 分别在同目录的服务模块），也不写正式
财务表。所有路径都是服务端可信元数据，永不回传给 Agent。
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.agent.errors import AgentApiError, ErrorCode
from app.api.agent.scope import require_project_scope
from app.core.config import Settings
from app.models.agent_monthly_report import (
    AgentMonthlyReportBuild,
    AgentMonthlyReportBuildStatus,
    AgentMonthlyReportFileKind,
    AgentMonthlyReportIdempotency,
    AgentMonthlyReportUpload,
    AgentMonthlyReportUploadStatus,
)

logger = logging.getLogger(__name__)

CSV_KIND = AgentMonthlyReportFileKind.transaction_csv.value
PDF_KIND = AgentMonthlyReportFileKind.summary_pdf.value
IDEMPOTENCY_BUILD = "build"
IDEMPOTENCY_CONFIRM = "confirm"

#: 按块读取/写入的块大小（1 MiB）：上传与摘要都按流累计，不信 Content-Length。
CHUNK_SIZE = 1024 * 1024
#: multipart 表单框架（boundary/头/字段名）的余量：文件上限之外额外允许这么多
#: 字节，超过即视为超限，避免 boundary 开销误伤刚好 50 MiB 的文件。
MULTIPART_FRAMING_SLACK = 64 * 1024


def utc_now() -> datetime:
    return datetime.now(UTC)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_request_hash(payload: dict[str, Any]) -> str:
    """请求体指纹（键排序、UTF-8、无空白差异）。"""
    return sha256_bytes(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    )


def new_expiry(settings: Settings) -> datetime:
    return utc_now() + timedelta(hours=settings.agent_monthly_report_ttl_hours)


def is_expired(row: AgentMonthlyReportUpload | AgentMonthlyReportBuild) -> bool:
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return expires_at <= utc_now()


# ── 存储布局 ────────────────────────────────────────────────────────────


def upload_dir(settings: Settings, upload_id: int) -> Path:
    return settings.agent_monthly_report_root / "uploads" / str(upload_id)


def build_dir(settings: Settings, build_id: int) -> Path:
    return settings.agent_monthly_report_root / "builds" / str(build_id)


def ensure_private_root(settings: Settings) -> Path:
    """预建并收紧私有根及其子目录（uploads / builds / tmp）。

    显式 0o700 逐层建：不依赖 umask，也不依赖增量 A 的
    ``mkdir(mode=0o700, parents=True)``——它只把 0o700 打在叶子目录上（Tia 在增量 A
    评审里的建议 #2）。**不预建 build 叶子目录**：``build_preview`` 要求
    ``exist_ok=False`` 的独占创建，预建会让它 FileExistsError。
    """
    root = prepare_private_dir(settings.agent_monthly_report_root)
    for child in ("uploads", "builds", "tmp"):
        prepare_private_dir(root / child)
    return root


def prepare_private_dir(path: Path) -> Path:
    """显式 0o700 建目录（含中间层）——不依赖 umask。

    ``parents=True`` 时逐层收紧：中间层若已存在则只补 chmod，不存在则用
    0o700 创建（``mkdir(parents=True, mode=...)`` 只作用于叶子）。
    """
    missing: list[Path] = []
    current = path
    while not current.exists() and current != current.parent:
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:  # 权限收紧失败不阻塞（如挂载点不支持）
        logger.warning("cannot chmod private dir %s", path)
    return path


def remove_tree_best_effort(path: Path) -> bool:
    """删除临时目录；失败只记录并返回 False，交给 janitor 重试。"""
    try:
        shutil.rmtree(path)
        return True
    except FileNotFoundError:
        return True
    except OSError:
        logger.exception("failed to clean agent monthly report dir %s", path)
        return False


# ── 归属与期限 ──────────────────────────────────────────────────────────


def owned_upload_or_404(
    db: Session, *, upload_id: int, agent_api_key_id: int
) -> AgentMonthlyReportUpload:
    """按归属取会话；不存在或属于其他 Agent 一律 404（不泄漏存在性）。"""
    upload = db.get(AgentMonthlyReportUpload, upload_id)
    if upload is None or upload.agent_api_key_id != agent_api_key_id:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message="上传会话不存在",
            agent_hint="upload_id 来自 POST /agent/monthly-reports/uploads；跨凭据不可见",
        )
    return upload


def owned_build_or_404(
    db: Session, *, build_id: int, agent_api_key_id: int
) -> AgentMonthlyReportBuild:
    build = db.get(AgentMonthlyReportBuild, build_id)
    if build is None or build.agent_api_key_id != agent_api_key_id:
        raise AgentApiError(
            ErrorCode.RESOURCE_NOT_FOUND,
            human_message="月报草稿任务不存在",
            agent_hint="build_id 来自 POST /agent/monthly-reports/builds；跨凭据不可见",
        )
    return build


def assert_not_expired(row: AgentMonthlyReportUpload | AgentMonthlyReportBuild) -> None:
    if is_expired(row):
        raise AgentApiError(
            ErrorCode.MONTHLY_REPORT_EXPIRED,
            human_message="临时输入或结果已过期（保留 24 小时）",
            agent_hint="新建上传会话与 build 后重试；阶段一不支持续期",
        )


def assert_project_scope(project_id: int, request: Request) -> None:
    """每步重查 project_scope：撤销后立即拒绝查询/下载/确认。"""
    require_project_scope(project_id, request)


# ── 幂等台账 ────────────────────────────────────────────────────────────


def find_idempotency(
    db: Session, *, agent_api_key_id: int, action: str, idempotency_key: str
) -> AgentMonthlyReportIdempotency | None:
    return db.execute(
        select(AgentMonthlyReportIdempotency).where(
            AgentMonthlyReportIdempotency.agent_api_key_id == agent_api_key_id,
            AgentMonthlyReportIdempotency.action == action,
            AgentMonthlyReportIdempotency.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()


def assert_same_request(
    record: AgentMonthlyReportIdempotency, request_hash: str
) -> None:
    """同幂等键必须同请求体；异体 → 409（契约要求，不静默复用旧结果）。"""
    if record.request_hash != request_hash:
        raise AgentApiError(
            ErrorCode.IDEMPOTENCY_KEY_CONFLICT,
            human_message="Idempotency-Key 已被用于不同的请求体",
            agent_hint="新请求请生成新的 Idempotency-Key；重放请保持请求体完全一致",
        )


def require_idempotency_key(request: Request) -> str:
    key = (request.headers.get("idempotency-key") or "").strip()
    if not key:
        raise AgentApiError(
            ErrorCode.VALIDATION_FAILED,
            human_message="缺少 Idempotency-Key",
            agent_hint=(
                "POST /builds 与 confirm 入库是危险写操作，必须带 Idempotency-Key；"
                "重试请复用同一 key 与同一请求体"
            ),
        )
    return key[:64]


def record_idempotency(
    db: Session,
    *,
    agent_api_key_id: int,
    action: str,
    idempotency_key: str,
    request_hash: str,
    build_id: int | None = None,
    report_id: int | None = None,
) -> AgentMonthlyReportIdempotency:
    record = AgentMonthlyReportIdempotency(
        agent_api_key_id=agent_api_key_id,
        action=action,
        idempotency_key=idempotency_key,
        request_hash=request_hash,
        build_id=build_id,
        report_id=report_id,
    )
    db.add(record)
    return record


# ── 状态流转（会话 ↔ build 汇总） ────────────────────────────────────────


def refresh_upload_status(db: Session, upload: AgentMonthlyReportUpload) -> None:
    """按 build 汇总会话状态（幂等：可由任意调用方重算）。"""
    if upload.status == AgentMonthlyReportUploadStatus.confirmed.value:
        return
    builds = db.execute(
        select(AgentMonthlyReportBuild).where(
            AgentMonthlyReportBuild.upload_id == upload.id
        )
    ).scalars().all()
    if any(
        build.status == AgentMonthlyReportBuildStatus.success.value for build in builds
    ):
        upload.status = AgentMonthlyReportUploadStatus.built.value
    elif any(
        build.status
        in (
            AgentMonthlyReportBuildStatus.queued.value,
            AgentMonthlyReportBuildStatus.running.value,
        )
        for build in builds
    ):
        upload.status = AgentMonthlyReportUploadStatus.building.value
    elif builds and all(
        build.status
        in (
            AgentMonthlyReportBuildStatus.failed.value,
            AgentMonthlyReportBuildStatus.expired.value,
            AgentMonthlyReportBuildStatus.cancelled.value,
        )
        for build in builds
    ):
        upload.status = AgentMonthlyReportUploadStatus.failed.value
    else:
        upload.status = AgentMonthlyReportUploadStatus.open.value

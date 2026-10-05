"""节点附件服务（BLF-1237 / P2）。

节点附件是**内务回传**用途：上传到现有 R2 桶，记录对象 key/原文件名/MIME/大小/上传者，
下载必须过鉴权 + 项目权限（每次请求都校验），删除按引用计数决定是否删 R2 对象。

R2 归属规则（唯一规则）：
    删除任何附件行之前，先看**两张附件表**里是否还有其它行引用同一个 ``r2_key``；
    无人引用才删对象，否则只删行（模板附件与项目副本共享同一个对象）。
    残留的无引用对象由既有 ``scripts/cleanup_r2_orphaned_files.py`` 兜底
    （前提是两表的 ``r2_key`` 已登记进 ``ArtifactService._IRREGULAR_KEY_COLUMNS``）。
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException, UploadFile, status as http_status
from slugify import slugify
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.project_workflow import ProjectWorkflowTaskAttachment
from app.models.project_workflow_template import WorkflowTemplateTaskAttachment

CHUNK_SIZE = 1024 * 1024

# 两张附件表（引用计数与孤儿判定都要一起看）。
ATTACHMENT_MODELS = (WorkflowTemplateTaskAttachment, ProjectWorkflowTaskAttachment)


def _safe_name(filename: str) -> str:
    """只保留基名 + 小写后缀，杜绝 ``../``、绝对路径与中文路径拼接风险。"""
    stem = Path(filename).stem
    ext = Path(filename).suffix.lower()
    base = slugify(stem)[:80] or "file"
    return f"{base}{ext}"


def validate_upload(file: UploadFile, settings: Settings) -> tuple[str, str]:
    """校验扩展名与 MIME（读取内容之前就能判定的部分）。"""
    if not file.filename:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )
    ext = Path(file.filename).suffix.lower()
    if ext not in settings.workflow_attachment_allowed_extensions:
        expected = ", ".join(sorted(settings.workflow_attachment_allowed_extensions))
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported extension: {ext} (expected: {expected})",
        )
    content_type = (file.content_type or "").lower() or "application/octet-stream"
    if content_type not in settings.workflow_attachment_allowed_content_types:
        raise HTTPException(
            status_code=http_status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported MIME type: {content_type}",
        )
    return ext, content_type


def store_upload(
    file: UploadFile,
    *,
    settings: Settings,
    project_slug: str,
    file_type: str,
) -> dict[str, Any]:
    """分块读入 → 校验大小 → 上传 R2，返回附件记录所需字段。

    附件只存 R2，不落本地缓存（本地缓存是报表脚本的语义，不适用于附件）。
    """
    ext, content_type = validate_upload(file, settings)

    if not settings.r2_enabled:
        raise HTTPException(
            status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud storage is not configured. Please contact administrator.",
        )

    buffer = bytearray()
    size = 0
    while True:
        chunk = file.file.read(CHUNK_SIZE)
        if not chunk:
            break
        size += len(chunk)
        if size > settings.workflow_attachment_max_bytes:
            raise HTTPException(
                status_code=http_status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="File too large",
            )
        buffer.extend(chunk)

    stored_name = f"{uuid.uuid4().hex}_{_safe_name(file.filename)}"
    from app.services.r2_service import upload_bytes_to_r2

    result = upload_bytes_to_r2(
        settings,
        bytes(buffer),
        stored_name,
        project_slug,
        file_type,
        content_type,
    )
    return {
        "r2_key": result["key"],
        "filename": file.filename[:256],
        "content_type": content_type,
        "file_size": size,
    }


def serialize_attachment(row: Any, *, include_origin: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": row.id,
        "filename": row.filename,
        "content_type": row.content_type,
        "file_size": row.file_size,
        "uploader": row.uploader,
        "created_at": row.created_at,
    }
    if include_origin:
        payload["origin"] = row.origin
    return payload


def r2_key_referenced_elsewhere(
    db: Session, r2_key: str, *, exclude_model: type, exclude_id: int
) -> bool:
    """两张附件表里是否还有其它行引用同一个 R2 对象。"""
    for model in ATTACHMENT_MODELS:
        stmt = select(model.id).where(model.r2_key == r2_key)
        if model is exclude_model:
            stmt = stmt.where(model.id != exclude_id)
        if db.execute(stmt).first() is not None:
            return True
    return False


def delete_attachment_row(
    db: Session,
    row: Any,
    *,
    settings: Settings,
) -> None:
    """先删行并提交（行是事实来源），再按引用计数决定是否删 R2 对象。

    R2 删除失败不阻塞行删除：按既有模式写 ``r2_delete_failures`` 死信表等待重试。
    """
    r2_key = row.r2_key
    model = type(row)
    row_id = int(row.id)

    still_referenced = r2_key_referenced_elsewhere(
        db, r2_key, exclude_model=model, exclude_id=row_id
    )
    db.delete(row)
    db.commit()

    if still_referenced:
        return

    from app.services.r2_lifecycle import record_delete_failure
    from app.services.r2_service import try_delete_file_from_r2

    result = try_delete_file_from_r2(settings, r2_key)
    if not result.success:
        record_delete_failure(
            r2_key,
            result,
            source="workflow_attachment_delete",
            context={"model": model.__name__, "row_id": row_id},
        )

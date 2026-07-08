"""Service layer for the Markdown/HTML page-render feature.

Responsibilities:
- validate extension (hard), MIME (soft), size, non-empty content
- sanitize user-provided title
- stream-read the upload in chunks, bound by settings.page_render_max_bytes
- upload to R2 (public bucket)
- persist UploadedPage row + audit log
- owner-scoped read / delete

We intentionally do NOT cache files locally — md/html has no downstream
processing scripts that need filesystem access (unlike report uploads).
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.uploaded_page import UploadedPage
from app.services.r2_service import try_delete_file_from_r2, upload_bytes_to_r2


_MARKDOWN_EXTS = {".md", ".markdown"}
_HTML_EXTS = {".html", ".htm"}

# Control chars (0x00-0x1f, 0x7f) plus the three ASCII chars that have meaning
# in HTML — we strip them so user-provided titles can't break the public <title>
# tag or get rendered as markup elsewhere.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f<>&]")


def _format_from_ext(ext: str) -> str | None:
    if ext in _MARKDOWN_EXTS:
        return "markdown"
    if ext in _HTML_EXTS:
        return "html"
    return None


def sanitize_title(raw: str | None, *, fallback_filename: str) -> str:
    """Strip control chars + HTML-meaningful chars, trim, clamp to 200 chars.

    Falls back to the filename stem when the user didn't provide a title.
    """
    if raw is None:
        candidate = Path(fallback_filename).stem
    else:
        candidate = raw

    cleaned = _CONTROL_CHARS_RE.sub("", candidate).strip()
    if not cleaned:
        cleaned = Path(fallback_filename).stem or "未命名页面"
        cleaned = _CONTROL_CHARS_RE.sub("", cleaned).strip() or "未命名页面"
    return cleaned[:200]


def _validate_and_read(file: UploadFile, settings: Settings) -> tuple[str, bytes]:
    """Validate the upload and return (ext, content_bytes).

    Raises HTTPException(400) for invalid extension / empty file and
    HTTPException(413) for oversize uploads. Mirrors upload_service.py's
    1MB-chunk streaming read pattern so a huge body never lands in memory.
    """
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="缺少文件名",
        )

    ext = Path(file.filename).suffix.lower()
    if ext not in settings.page_render_allowed_extensions:
        expected = ", ".join(sorted(settings.page_render_allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的文件类型: {ext}（允许: {expected}）",
        )

    # Soft MIME check — many browsers mis-report .md MIME, so we only reject
    # when the browser sent something but it isn't on our (generous) list.
    content_type = (file.content_type or "").lower()
    if content_type and content_type not in settings.page_render_allowed_content_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的 MIME 类型: {content_type}",
        )

    chunks: list[bytes] = []
    total = 0
    max_bytes = settings.page_render_max_bytes
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"文件超过 {max_bytes} 字节上限",
            )
        chunks.append(chunk)

    if total == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="文件为空",
        )

    return ext, b"".join(chunks)


def save_uploaded_page(
    *,
    db: Session,
    settings: Settings,
    file: UploadFile,
    owner_user_id: int,
    title: str | None,
) -> UploadedPage:
    """Validate, upload to R2, persist row. Caller commits."""
    ext, content = _validate_and_read(file, settings)

    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="云存储未配置，请联系管理员",
        )

    source_format = _format_from_ext(ext)
    assert source_format is not None  # guaranteed by ext whitelist above

    stored_name = f"{uuid.uuid4().hex}{ext}"
    content_type = (file.content_type or "").lower() or "application/octet-stream"

    r2_result = upload_bytes_to_r2(
        settings,
        content,
        stored_name,
        project_slug="special-pages",
        file_type=f"user_{owner_user_id}",
        content_type=content_type,
    )

    safe_title = sanitize_title(title, fallback_filename=file.filename or "未命名页面")

    page = UploadedPage(
        owner_user_id=owner_user_id,
        title=safe_title,
        source_format=source_format,
        original_filename=(file.filename or "")[:255],
        content_type=content_type,
        file_size=len(content),
        r2_key=r2_result["key"],
        public_url=r2_result["url"],
    )
    db.add(page)
    db.flush()  # populate page.id without committing yet — caller controls tx
    return page


def get_page_by_id(db: Session, page_id: str) -> UploadedPage | None:
    return db.get(UploadedPage, page_id)


def list_user_pages(
    db: Session, owner_user_id: int, limit: int, offset: int
) -> list[UploadedPage]:
    stmt = (
        select(UploadedPage)
        .where(UploadedPage.owner_user_id == owner_user_id)
        .order_by(UploadedPage.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(db.execute(stmt).scalars().all())


def count_user_pages(db: Session, owner_user_id: int) -> int:
    stmt = select(func.count()).select_from(UploadedPage).where(
        UploadedPage.owner_user_id == owner_user_id
    )
    return int(db.execute(stmt).scalar_one())


def delete_uploaded_page(
    *,
    db: Session,
    settings: Settings,
    page: UploadedPage,
) -> None:
    """Best-effort R2 delete (never raises) + DB row delete. Caller commits."""
    try_delete_file_from_r2(settings, page.r2_key, log_failure=True)
    db.delete(page)
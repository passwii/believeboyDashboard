from pathlib import Path
import re
import shutil
import uuid

from fastapi import HTTPException, UploadFile, status
from slugify import slugify

from app.core.config import Settings
from app.services.report_type_service import (
    legacy_report_types_for,
    normalize_report_type,
)

TYPE_ALLOWED_EXTENSIONS: dict[str, set[str]] = {
    "business_report": {".csv"},
    "sales_report": {".txt"},
    "inventory_report": {".txt"},
    "inventory_ledger": {".csv"},
    "ad_product_report": {".xlsx"},
    "payment_report": {".csv"},
    "transaction_csv": {".csv"},
    "monthly_summary_pdf": {".pdf"},
    "category_research_xlsx": {".xlsx"},
    "ad_search_term_report": {".xlsx"},
    "report_upload_temp": {".txt", ".csv", ".xlsx"},
}


def _safe_name(filename: str) -> str:
    stem = Path(filename).stem
    ext = Path(filename).suffix.lower()
    base = slugify(stem)[:80] or "file"
    return f"{base}{ext}"


def _safe_project_folder_name(project_name: str) -> str:
    raw = (project_name or "").strip()
    if not raw:
        return "project"

    # Keep readable project names (including Chinese), but block path/control chars.
    safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", raw)
    safe = re.sub(r"\s+", "-", safe).strip(" .-")
    if safe in {"", ".", ".."}:
        safe = slugify(raw)
    return (safe or "project")[:80]


def save_upload_file(
    file: UploadFile, settings: Settings, project_name: str, file_type: str
) -> dict:
    """
    Upload a file to R2 storage, then sync to local UPLOAD_ROOT as a temporary cache.

    - All files are stored in R2 (the source of truth, cloud-only).
    - CSV/TXT/XLSX files are also cached locally in UPLOAD_ROOT so that report
      processing scripts (which read from the local filesystem) can access them.
    - PDF files are NOT cached locally; they are accessed via their R2 URL.
    - When a report task finishes processing, it can delete the local cache
      of that file via delete_upload_file_local().

    Args:
        file: FastAPI UploadFile
        settings: Application settings
        project_name: Project name for path organization
        file_type: File type (e.g., 'monthly_summary_pdf')

    Returns:
        dict with r2_key, r2_url, file_id, original_filename, size, local_path
    """
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )

    normalized_file_type = normalize_report_type(file_type)
    ext = Path(file.filename).suffix.lower()
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS.get(
        normalized_file_type, settings.allowed_upload_extensions
    )
    if ext not in allowed_extensions:
        expected = ", ".join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported extension: {ext} (expected: {expected})",
        )

    content_type = (file.content_type or "").lower()
    if content_type and content_type not in settings.allowed_content_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported MIME type: {content_type}",
        )

    project_slug = _safe_project_folder_name(project_name)
    type_slug = slugify(normalized_file_type)[:50] or "file"

    # Generate unique filename
    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f"{unique_id}_{safe_name}"

    # Read file content
    file_content = b""
    size = 0
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > settings.max_upload_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="File too large",
            )
        file_content += chunk

    # Upload to R2 (required)
    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud storage is not configured. Please contact administrator.",
        )

    from app.services.r2_service import download_file_to_path, upload_bytes_to_r2

    r2_result = upload_bytes_to_r2(
        settings,
        file_content,
        stored_name,
        project_slug,
        type_slug,
        content_type or "application/octet-stream",
    )

    # Sync to local UPLOAD_ROOT for report processing scripts that read local files.
    # PDF files are kept in R2 only (accessed via URL); CSV/TXT/XLSX files are cached locally.
    local_dest = settings.upload_root / project_slug / type_slug / stored_name
    local_dest.parent.mkdir(parents=True, exist_ok=True)
    download_file_to_path(settings, r2_result["key"], local_dest)

    return {
        "file_id": r2_result["key"],
        "r2_key": r2_result["key"],
        "r2_url": r2_result["url"],
        "file_path": r2_result["url"],
        "filename": stored_name,
        "original_filename": file.filename,
        "size": size,
        "local_path": str(local_dest) if ext != ".pdf" else None,
    }


def save_report_upload_temp_file(file: UploadFile, settings: Settings) -> dict:
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )

    ext = Path(file.filename).suffix.lower()
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS["report_upload_temp"]
    if ext not in allowed_extensions:
        expected = ", ".join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported extension: {ext} (expected: {expected})",
        )

    folder = settings.upload_root / "_report_upload_tmp"
    folder.mkdir(parents=True, exist_ok=True)

    temp_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f"{temp_id}_{safe_name}"
    path = folder / stored_name

    size = 0
    with path.open("wb") as target:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail="File too large",
                )
            target.write(chunk)

    return {
        "temp_file_id": stored_name,
        "file_path": str(path.resolve()),
        "original_filename": file.filename,
        "size": size,
    }


def resolve_report_upload_temp_file_path(settings: Settings, temp_file_id: str) -> Path:
    path = settings.upload_root / "_report_upload_tmp" / temp_file_id
    if path.exists() and path.is_file():
        return path
    raise FileNotFoundError(f"temp_file_id not found: {temp_file_id}")


def finalize_report_upload_temp_file(
    settings: Settings,
    *,
    temp_file_id: str,
    original_filename: str,
    project_name: str,
    file_type: str,
) -> dict:
    normalized_file_type = normalize_report_type(file_type)
    source = resolve_report_upload_temp_file_path(settings, temp_file_id)
    ext = source.suffix.lower()
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS.get(
        normalized_file_type, settings.allowed_upload_extensions
    )
    if ext not in allowed_extensions:
        expected = ", ".join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported extension: {ext} (expected: {expected})",
        )

    project_slug = _safe_project_folder_name(project_name)
    type_slug = slugify(normalized_file_type)[:50] or "file"
    folder = settings.upload_root / project_slug / type_slug
    folder.mkdir(parents=True, exist_ok=True)

    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(original_filename or source.name)
    stored_name = f"{unique_id}_{safe_name}"
    destination = folder / stored_name
    shutil.copy2(source, destination)

    return {
        "file_id": stored_name,
        "file_path": str(destination.resolve()),
        "filename": stored_name,
        "original_filename": original_filename or source.name,
        "size": destination.stat().st_size,
    }


def delete_upload_file_local(
    settings: Settings, project_name: str, file_type: str, file_id: str
) -> bool:
    """
    Delete a locally cached upload file after report processing is complete.
    The source of truth is already in R2, so the local cache can be safely removed.
    """
    local_path = build_upload_file_path(settings, project_name, file_type, file_id)
    if local_path.exists():
        try:
            local_path.unlink()
            return True
        except OSError:
            return False
    return False


def build_upload_file_path(
    settings: Settings, project_name: str, file_type: str, file_id: str
) -> Path:
    if not file_id:
        raise FileNotFoundError("file_id not found: ")

    project_slug = _safe_project_folder_name(project_name)
    normalized_file_type = normalize_report_type(file_type)
    normalized_path = (
        settings.upload_root
        / project_slug
        / (slugify(normalized_file_type)[:50] or "file")
        / file_id
    )
    if normalized_path.exists():
        return normalized_path

    for legacy_type in legacy_report_types_for(normalized_file_type):
        legacy_path = (
            settings.upload_root
            / project_slug
            / (slugify(legacy_type)[:50] or "file")
            / file_id
        )
        if legacy_path.exists():
            return legacy_path

    return normalized_path


def resolve_upload_file_path(
    settings: Settings, project_name: str, file_type: str, file_id: str
) -> Path:
    path = build_upload_file_path(settings, project_name, file_type, file_id)
    if path.exists():
        return path
    raise FileNotFoundError(f"file_id not found: {file_id}")


def _safe_user_id_slug(user_id: str) -> str:
    """Sanitize a UUID-like user_id into a path-safe folder name.

    Falls back to ``user_<short>`` if the value is empty or all unsafe chars.
    """
    raw = (user_id or "").strip()
    if not raw:
        return "user_unknown"
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", raw)
    safe = re.sub(r"\.+", ".", safe).strip(" .-_")
    return safe[:80] or "user_unknown"


def save_user_avatar_file(file: UploadFile, settings: Settings, user_id: str) -> dict:
    """
    Upload a user profile picture to R2.

    Unlike report uploads, avatars are stored exclusively in R2 (no local
    mirror) and capped at ``settings.avatar_max_bytes``. The path layout
    is ``avatars/{user_id}/{uuid}.{ext}`` so each user gets its own
    namespace and old objects can be deleted without collisions.

    Args:
        file: FastAPI UploadFile
        settings: Application settings
        user_id: Authenticated user id (used as path segment, never trusted
            from the request body).

    Returns:
        dict with ``r2_key``, ``r2_url``, ``size``, ``content_type``.
    """
    if not file.filename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Missing filename"
        )

    ext = Path(file.filename).suffix.lower()
    if ext not in settings.avatar_allowed_extensions:
        expected = ", ".join(sorted(settings.avatar_allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported avatar extension: {ext} (expected: {expected})",
        )

    content_type = (file.content_type or "").lower()
    if content_type and content_type not in settings.avatar_allowed_content_types:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported avatar MIME type: {content_type}",
        )

    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Cloud storage is not configured. Please contact administrator.",
        )

    user_slug = _safe_user_id_slug(user_id)
    type_slug = "avatar"
    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f"{unique_id}_{safe_name}"

    # Stream-read with a strict size cap so we don't allocate the whole body
    # in memory before rejecting oversized uploads.
    file_content = b""
    size = 0
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > settings.avatar_max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Avatar exceeds {settings.avatar_max_bytes} bytes",
            )
        file_content += chunk

    from app.services.r2_service import upload_bytes_to_r2

    r2_result = upload_bytes_to_r2(
        settings,
        file_content,
        stored_name,
        user_slug,
        type_slug,
        content_type or "application/octet-stream",
    )

    return {
        "r2_key": r2_result["key"],
        "r2_url": r2_result["url"],
        "size": size,
        "content_type": content_type or "application/octet-stream",
    }

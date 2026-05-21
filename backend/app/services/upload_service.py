from pathlib import Path
import re
import shutil
import uuid

from fastapi import HTTPException, UploadFile, status
from slugify import slugify

from app.core.config import Settings
from app.services.report_type_service import legacy_report_types_for, normalize_report_type

TYPE_ALLOWED_EXTENSIONS: dict[str, set[str]] = {
    'business_report': {'.csv'},
    'sales_report': {'.txt'},
    'inventory_report': {'.txt'},
    'ad_product_report': {'.xlsx'},
    'payment_report': {'.csv'},
    'monthly_summary_pdf': {'.pdf'},
    'category_research_xlsx': {'.xlsx'},
    'ad_search_term_report': {'.xlsx'},
    'report_upload_temp': {'.txt', '.csv', '.xlsx'},
}


def _safe_name(filename: str) -> str:
    stem = Path(filename).stem
    ext = Path(filename).suffix.lower()
    base = slugify(stem)[:80] or 'file'
    return f"{base}{ext}"


def _safe_project_folder_name(project_name: str) -> str:
    raw = (project_name or '').strip()
    if not raw:
        return 'project'

    # Keep readable project names (including Chinese), but block path/control chars.
    safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '-', raw)
    safe = re.sub(r'\s+', '-', safe).strip(' .-')
    if safe in {'', '.', '..'}:
        safe = slugify(raw)
    return (safe or 'project')[:80]


def save_upload_file(file: UploadFile, settings: Settings, project_name: str, file_type: str) -> dict:
    """
    Upload a file to R2 storage (cloud-only, no local storage).

    Args:
        file: FastAPI UploadFile
        settings: Application settings
        project_name: Project name for path organization
        file_type: File type (e.g., 'monthly_summary_pdf')

    Returns:
        dict with r2_key, r2_url, file_id, original_filename, size
    """
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    normalized_file_type = normalize_report_type(file_type)
    ext = Path(file.filename).suffix.lower()
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS.get(normalized_file_type, settings.allowed_upload_extensions)
    if ext not in allowed_extensions:
        expected = ', '.join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    content_type = (file.content_type or '').lower()
    if content_type and content_type not in settings.allowed_content_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'Unsupported MIME type: {content_type}')

    project_slug = _safe_project_folder_name(project_name)
    type_slug = slugify(normalized_file_type)[:50] or 'file'

    # Generate unique filename
    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f'{unique_id}_{safe_name}'

    # Read file content
    file_content = b''
    size = 0
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > settings.max_upload_bytes:
            raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail='File too large')
        file_content += chunk

    # Upload to R2 (required)
    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Cloud storage is not configured. Please contact administrator.'
        )

    from app.services.r2_service import upload_bytes_to_r2
    r2_result = upload_bytes_to_r2(
        settings,
        file_content,
        stored_name,
        project_slug,
        type_slug,
        content_type or 'application/octet-stream',
    )

    return {
        'file_id': r2_result['key'],
        'r2_key': r2_result['key'],
        'r2_url': r2_result['url'],
        'file_path': r2_result['url'],
        'filename': stored_name,
        'original_filename': file.filename,
        'size': size,
    }


def save_report_upload_temp_file(file: UploadFile, settings: Settings) -> dict:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    ext = Path(file.filename).suffix.lower()
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS['report_upload_temp']
    if ext not in allowed_extensions:
        expected = ', '.join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    folder = settings.upload_root / '_report_upload_tmp'
    folder.mkdir(parents=True, exist_ok=True)

    temp_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f'{temp_id}_{safe_name}'
    path = folder / stored_name

    size = 0
    with path.open('wb') as target:
        while True:
            chunk = file.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > settings.max_upload_bytes:
                path.unlink(missing_ok=True)
                raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail='File too large')
            target.write(chunk)

    return {
        'temp_file_id': stored_name,
        'file_path': str(path.resolve()),
        'original_filename': file.filename,
        'size': size,
    }


def resolve_report_upload_temp_file_path(settings: Settings, temp_file_id: str) -> Path:
    path = settings.upload_root / '_report_upload_tmp' / temp_file_id
    if path.exists() and path.is_file():
        return path
    raise FileNotFoundError(f'temp_file_id not found: {temp_file_id}')


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
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS.get(normalized_file_type, settings.allowed_upload_extensions)
    if ext not in allowed_extensions:
        expected = ', '.join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unsupported extension: {ext} (expected: {expected})',
        )

    project_slug = _safe_project_folder_name(project_name)
    type_slug = slugify(normalized_file_type)[:50] or 'file'
    folder = settings.upload_root / project_slug / type_slug
    folder.mkdir(parents=True, exist_ok=True)

    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(original_filename or source.name)
    stored_name = f'{unique_id}_{safe_name}'
    destination = folder / stored_name
    shutil.copy2(source, destination)

    return {
        'file_id': stored_name,
        'file_path': str(destination.resolve()),
        'filename': stored_name,
        'original_filename': original_filename or source.name,
        'size': destination.stat().st_size,
    }


def build_upload_file_path(settings: Settings, project_name: str, file_type: str, file_id: str) -> Path:
    if not file_id:
        raise FileNotFoundError('file_id not found: ')

    project_slug = _safe_project_folder_name(project_name)
    normalized_file_type = normalize_report_type(file_type)
    normalized_path = settings.upload_root / project_slug / (slugify(normalized_file_type)[:50] or 'file') / file_id
    if normalized_path.exists():
        return normalized_path

    for legacy_type in legacy_report_types_for(normalized_file_type):
        legacy_path = settings.upload_root / project_slug / (slugify(legacy_type)[:50] or 'file') / file_id
        if legacy_path.exists():
            return legacy_path

    return normalized_path


def resolve_upload_file_path(settings: Settings, project_name: str, file_type: str, file_id: str) -> Path:
    path = build_upload_file_path(settings, project_name, file_type, file_id)
    if path.exists():
        return path
    raise FileNotFoundError(f'file_id not found: {file_id}')

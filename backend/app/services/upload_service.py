from pathlib import Path
import re
import uuid

from fastapi import HTTPException, UploadFile, status
from slugify import slugify

from app.core.config import Settings

TYPE_ALLOWED_EXTENSIONS: dict[str, set[str]] = {
    'business_report': {'.csv'},
    'sales_report': {'.txt'},
    'inventory_report': {'.txt'},
    'ad_report': {'.xlsx'},
    'payment_report': {'.csv'},
    'monthly_summary_pdf': {'.pdf'},
    'category_research_xlsx': {'.xlsx'},
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
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    ext = Path(file.filename).suffix.lower()
    allowed_extensions = TYPE_ALLOWED_EXTENSIONS.get(file_type, settings.allowed_upload_extensions)
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
    type_slug = slugify(file_type)[:50] or 'file'
    folder = settings.upload_root / project_slug / type_slug
    folder.mkdir(parents=True, exist_ok=True)

    unique_id = uuid.uuid4().hex
    safe_name = _safe_name(file.filename)
    stored_name = f'{unique_id}_{safe_name}'
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
        'file_id': stored_name,
        'file_path': str(path.resolve()),
        'filename': stored_name,
        'original_filename': file.filename,
        'size': size,
    }


def build_upload_file_path(settings: Settings, project_name: str, file_type: str, file_id: str) -> Path:
    if not file_id:
        raise FileNotFoundError('file_id not found: ')

    project_slug = _safe_project_folder_name(project_name)
    type_slug = slugify(file_type)[:50] or 'file'
    return settings.upload_root / project_slug / type_slug / file_id


def resolve_upload_file_path(settings: Settings, project_name: str, file_type: str, file_id: str) -> Path:
    path = build_upload_file_path(settings, project_name, file_type, file_id)
    if path.exists():
        return path
    raise FileNotFoundError(f'file_id not found: {file_id}')

from pathlib import Path
import uuid

from fastapi import HTTPException, UploadFile, status
from slugify import slugify

from app.core.config import Settings


def _safe_name(filename: str) -> str:
    stem = Path(filename).stem
    ext = Path(filename).suffix.lower()
    base = slugify(stem)[:80] or 'file'
    return f"{base}{ext}"


def save_upload_file(file: UploadFile, settings: Settings, project_name: str, file_type: str) -> dict:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Missing filename')

    ext = Path(file.filename).suffix.lower()
    if ext not in settings.allowed_upload_extensions:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'Unsupported extension: {ext}')

    content_type = (file.content_type or '').lower()
    if content_type and content_type not in settings.allowed_content_types:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'Unsupported MIME type: {content_type}')

    project_slug = slugify(project_name)[:80] or 'project'
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

from __future__ import annotations

import math
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Request, Response, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.services import project_service
from app.core.config import get_settings
from app.schemas.platform_revenue import (
    PlatformRevenueAttachment,
    PlatformRevenueCreate,
    PlatformRevenueItem,
    PlatformRevenueListResponse,
    PlatformRevenueUpdate,
)
from app.services import platform_revenue_service
from app.services.audit_log_service import append_operation_audit_log

router = APIRouter(dependencies=[Depends(protected)])

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}
CONTENT_TYPE_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
}


def _platform_revenue_image_dir() -> Path:
    settings = get_settings()
    root = settings.upload_root / 'platform_revenues'
    root.mkdir(parents=True, exist_ok=True)
    return root


def _serialize_item(row) -> PlatformRevenueItem:
    attachments = []
    for att in (row.attachments or []):
        if isinstance(att, dict):
            attachments.append(PlatformRevenueAttachment(**att))
        else:
            attachments.append(att)
    return PlatformRevenueItem(
        id=row.id,
        project_id=row.project_id,
        project_name=row.project_name,
        country=row.country,
        received_date=row.received_date,
        amount=row.amount,
        currency=row.currency,
        exchange_rate=row.exchange_rate,
        revenue_type=row.revenue_type,
        note=row.note,
        attachments=attachments,
        created_by=row.created_by,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get('/platform-revenues', response_model=PlatformRevenueListResponse)
def list_platform_revenues(
    request: Request,
    project_id: int | None = None,
    year: int | None = None,
    month: int | None = None,
    country: str | None = None,
    currency: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> PlatformRevenueListResponse:
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 200)

    rows, total = platform_revenue_service.list_revenues(
        db,
        page=safe_page,
        page_size=safe_page_size,
        project_id=project_id,
        year=year,
        month=month,
        country=country,
        currency=currency,
        operator=operator,
        is_admin=bool(is_admin),
    )

    total_pages = math.ceil(total / safe_page_size) if total > 0 else 1

    return PlatformRevenueListResponse(
        items=[_serialize_item(row) for row in rows],
        total=total,
        page=safe_page,
        page_size=safe_page_size,
        total_pages=total_pages,
    )


@router.get('/platform-revenues/{revenue_id}', response_model=PlatformRevenueItem)
def get_platform_revenue(
    revenue_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> PlatformRevenueItem:
    row = platform_revenue_service.get_revenue(db, revenue_id, operator=operator, is_admin=bool(is_admin))
    return _serialize_item(row)


@router.post('/platform-revenues', response_model=PlatformRevenueItem, status_code=status.HTTP_201_CREATED)
def create_platform_revenue(
    request: Request,
    payload: PlatformRevenueCreate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> PlatformRevenueItem:
    operator_name = request.headers.get('X-Operator', 'system')

    # Get project name
    from app.models import Project
    from sqlalchemy import select
    project = db.execute(select(Project).where(Project.id == payload.project_id)).scalars().first()
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="项目不存在")

    attachments_data = None
    if payload.attachments:
        attachments_data = [att.model_dump() for att in payload.attachments]

    row = platform_revenue_service.create_revenue(
        db,
        project_id=payload.project_id,
        project_name=project.project_name,
        country=payload.country,
        received_date=payload.received_date,
        amount=payload.amount,
        currency=payload.currency,
        exchange_rate=payload.exchange_rate,
        revenue_type=payload.revenue_type,
        note=payload.note,
        attachments=attachments_data,
        operator=operator_name,
        is_admin=bool(is_admin),
    )
    db.commit()

    # Audit log
    append_operation_audit_log(
        db,
        action='platform_revenues.create',
        target_type='platform_revenue',
        target_id=row.id,
        operator=operator_name,
        after={'data': payload.model_dump()},
        request=request,
    )
    db.commit()

    return _serialize_item(row)


@router.patch('/platform-revenues/{revenue_id}', response_model=PlatformRevenueItem)
def update_platform_revenue(
    request: Request,
    revenue_id: int,
    payload: PlatformRevenueUpdate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> PlatformRevenueItem:
    operator_name = request.headers.get('X-Operator', 'system')

    update_data = payload.model_dump(exclude_unset=True)
    if payload.attachments is not None:
        update_data['attachments'] = [att.model_dump() for att in payload.attachments]

    row = platform_revenue_service.update_revenue(
        db,
        revenue_id=revenue_id,
        operator=operator_name,
        is_admin=bool(is_admin),
        **update_data,
    )
    db.commit()

    # Audit log
    append_operation_audit_log(
        db,
        action='platform_revenues.update',
        target_type='platform_revenue',
        target_id=revenue_id,
        operator=operator_name,
        after={'data': payload.model_dump(exclude_unset=True)},
        request=request,
    )
    db.commit()

    return _serialize_item(row)


@router.delete('/platform-revenues/{revenue_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_platform_revenue(
    request: Request,
    revenue_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> Response:
    operator_name = request.headers.get('X-Operator', 'system')

    # Get before state for audit (with permission check)
    row = platform_revenue_service.get_revenue(db, revenue_id, operator=operator_name, is_admin=bool(is_admin))
    before_data = {
        'id': row.id,
        'project_id': row.project_id,
        'project_name': row.project_name,
        'country': row.country,
        'received_date': str(row.received_date),
        'amount': str(row.amount),
        'currency': row.currency,
    }

    platform_revenue_service.delete_revenue(db, revenue_id, operator=operator_name, is_admin=bool(is_admin))
    db.commit()

    # Audit log
    append_operation_audit_log(
        db,
        action='platform_revenues.delete',
        target_type='platform_revenue',
        target_id=revenue_id,
        operator=operator_name,
        before={'data': before_data},
        request=request,
    )
    db.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post('/platform-revenues/upload-image')
async def upload_platform_revenue_image(
    request: Request,
    file: UploadFile = File(...),
) -> dict:
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Unsupported file type')

    payload = await file.read()
    if not payload or len(payload) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='File size exceeds 10MB')

    try:
        image = Image.open(BytesIO(payload))
        image = ImageOps.exif_transpose(image)
        image.load()
    except UnidentifiedImageError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Unsupported image content') from None

    image = image.convert('RGB')
    image.thumbnail((1920, 1920))

    image_id = uuid4().hex
    image_dir = _platform_revenue_image_dir()
    image_name = f'{image_id}.webp'
    image_path = image_dir / image_name

    image.save(image_path, format='WEBP', quality=82, method=6)

    uploaded_at = datetime.now(timezone.utc).isoformat()

    return {
        'id': image_id,
        'filename': file.filename or image_name,
        'stored_path': str(image_path),
        'url': f'/api/platform-revenues/images/{image_name}',
        'size': image_path.stat().st_size,
        'created_at': uploaded_at,
    }


@router.get('/platform-revenues/images/{filename}')
def get_platform_revenue_image(filename: str) -> Response:
    if not filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid filename')

    root = _platform_revenue_image_dir().resolve()
    resolved = (root / filename).resolve()
    if not str(resolved).startswith(str(root)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid filename')
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Image not found')

    content_type = CONTENT_TYPE_MAP.get(resolved.suffix.lower(), 'application/octet-stream')
    return Response(
        content=resolved.read_bytes(),
        media_type=content_type,
        headers={'Cache-Control': 'private, max-age=86400'},
    )


@router.get('/platform-revenues/project-countries/{project_id}')
def get_project_countries(
    project_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
) -> dict:
    """Get the list of countries (sites) for a project."""
    # Check permission for non-admin users
    project_service.ensure_project_access(db, project_id, operator=operator, is_admin=bool(is_admin))
    countries = platform_revenue_service.get_project_countries(db, project_id)
    return {'countries': countries}
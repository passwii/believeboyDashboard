from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from pydantic import BaseModel

from app.api.deps import get_db_session, protected
from app.core.config import get_settings
from app.schemas.exchange_rate import (
    ExchangeRateCreate,
    ExchangeRateItem,
    ExchangeRateListResponse,
    ExchangeRateOption,
    ExchangeRateOptionsResponse,
    ExchangeRateUpdate,
    ExchangeRateUploadResponse,
)
from app.services import exchange_rate_service
from app.services.r2_service import upload_bytes_to_r2

router = APIRouter(dependencies=[Depends(protected)])

MAX_IMAGE_BYTES = 10 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}
# R2 storage paths
R2_PROJECT_SLUG = 'exchange-rate-notes'
R2_IMAGES_FOLDER = 'images'
R2_THUMBS_FOLDER = 'thumbs'


def _get_r2_image_url(image_name: str) -> str:
    """Generate R2 public URL for an image."""
    settings = get_settings()
    base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    return f"{base}/{R2_PROJECT_SLUG}/{R2_IMAGES_FOLDER}/{image_name}"


def _get_r2_thumb_url(thumb_name: str) -> str:
    """Generate R2 public URL for a thumbnail."""
    settings = get_settings()
    base = settings.r2_public_url or f"{settings.r2_endpoint_url}/{settings.r2_bucket_name}"
    return f"{base}/{R2_PROJECT_SLUG}/{R2_THUMBS_FOLDER}/{thumb_name}"


def _serialize_item(row) -> ExchangeRateItem:
    return ExchangeRateItem(**exchange_rate_service.serialize_exchange_rate(row))


@router.get('/exchange-rates', response_model=ExchangeRateListResponse)
def list_exchange_rates(
    currency: str | None = None,
    year_month: str | None = None,
    page: int = 1,
    page_size: int = 50,
    db: Session = Depends(get_db_session),
) -> ExchangeRateListResponse:
    safe_page = max(page, 1)
    safe_page_size = min(max(page_size, 1), 200)
    rows, total = exchange_rate_service.list_exchange_rates(
        db,
        currency=currency,
        year_month=year_month,
        page=safe_page,
        page_size=safe_page_size,
    )
    return ExchangeRateListResponse(
        items=[_serialize_item(row) for row in rows],
        total=total,
        page=safe_page,
        page_size=safe_page_size,
    )


class ExchangeRateResolveResponse(BaseModel):
    currency: str
    year_month: str
    rate: float | None
    description: str | None
    note_images: list
    source: str  # 'exact' | 'fallback' | 'latest' | 'not_found'


@router.get('/exchange-rates/resolve')
def resolve_exchange_rate(
    currency: str,
    year_month: str | None = None,
    db: Session = Depends(get_db_session),
) -> ExchangeRateResolveResponse:
    """
    解析汇率：优先精确匹配指定年月，找不到则回退到最近的历史记录。
    适用于回款录入时自动拉取汇率。
    """
    import re

    # 支持 year_month=2024-03 或 year_month=2024-3 格式
    if year_month and not re.match(r'^\d{4}-\d{1,2}$', year_month):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='year_month must be YYYY-MM format')

    if not year_month:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='year_month is required')

    row = exchange_rate_service.get_exchange_rate_by_currency_month_with_fallback(
        db,
        currency=currency.strip().upper(),
        year_month=year_month,
    )
    if row is None:
        return ExchangeRateResolveResponse(
            currency=currency.strip().upper(),
            year_month=year_month,
            rate=None,
            description=None,
            note_images=[],
            source='not_found',
        )

    return ExchangeRateResolveResponse(
        currency=row.currency,
        year_month=row.year_month,
        rate=float(row.rate),
        description=row.description,
        note_images=exchange_rate_service.serialize_note_images(row.note_images),
        source='exact' if row.year_month == year_month else 'fallback',
    )


@router.get('/exchange-rates/options', response_model=ExchangeRateOptionsResponse)
def get_exchange_rate_options(db: Session = Depends(get_db_session)) -> ExchangeRateOptionsResponse:
    rows = exchange_rate_service.list_exchange_rate_rows(db)

    currency_map: dict[str, ExchangeRateOption] = {}
    year_values: set[int] = set()
    for row in rows:
        if row.currency not in currency_map:
            currency_map[row.currency] = ExchangeRateOption(
                value=row.currency,
                label=f'{row.currency} - {row.currency_name or row.currency}',
            )
        year_values.add(int(row.year_month.split('-')[0]))

    return ExchangeRateOptionsResponse(
        currencies=list(currency_map.values()),
        years=[ExchangeRateOption(value=year, label=f'{year}年') for year in sorted(year_values, reverse=True)],
        months=[ExchangeRateOption(value=month, label=f'{month}月') for month in range(1, 13)],
    )


@router.get('/exchange-rates/{exchange_rate_id}', response_model=ExchangeRateItem)
def get_exchange_rate(exchange_rate_id: int, db: Session = Depends(get_db_session)) -> ExchangeRateItem:
    row = exchange_rate_service.get_exchange_rate(db, exchange_rate_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Exchange rate not found')
    return _serialize_item(row)


@router.post('/exchange-rates', response_model=ExchangeRateItem, status_code=status.HTTP_201_CREATED)
def create_exchange_rate(payload: ExchangeRateCreate, db: Session = Depends(get_db_session)) -> ExchangeRateItem:
    year_month = exchange_rate_service.normalize_year_month(
        year_month=payload.year_month,
        year=payload.year,
        month=payload.month,
    )
    duplicate = exchange_rate_service.get_exchange_rate_by_currency_month(db, currency=payload.currency, year_month=year_month)
    if duplicate:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='Exchange rate for this currency and month already exists')

    row = exchange_rate_service.create_exchange_rate(db, payload)
    db.commit()
    return _serialize_item(row)


@router.put('/exchange-rates/{exchange_rate_id}', response_model=ExchangeRateItem)
def update_exchange_rate(
    exchange_rate_id: int,
    payload: ExchangeRateUpdate,
    db: Session = Depends(get_db_session),
) -> ExchangeRateItem:
    row = exchange_rate_service.get_exchange_rate(db, exchange_rate_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Exchange rate not found')

    current_year, current_month = row.year_month.split('-')
    target_year_month = exchange_rate_service.normalize_year_month(
        year_month=payload.year_month,
        year=payload.year if payload.year is not None else int(current_year),
        month=payload.month if payload.month is not None else int(current_month),
    )
    target_currency = payload.currency.strip() if payload.currency is not None else row.currency
    duplicate = exchange_rate_service.get_exchange_rate_by_currency_month(db, currency=target_currency, year_month=target_year_month)
    if duplicate and duplicate.id != exchange_rate_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail='Exchange rate for this currency and month already exists')

    updated = exchange_rate_service.update_exchange_rate(db, row, payload)
    db.commit()
    return _serialize_item(updated)


@router.delete('/exchange-rates/{exchange_rate_id}', status_code=status.HTTP_204_NO_CONTENT)
def delete_exchange_rate(exchange_rate_id: int, db: Session = Depends(get_db_session)) -> Response:
    row = exchange_rate_service.get_exchange_rate(db, exchange_rate_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Exchange rate not found')
    exchange_rate_service.delete_exchange_rate(db, row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post('/exchange-rates/upload-image', response_model=ExchangeRateUploadResponse)
async def upload_exchange_rate_image(file: UploadFile = File(...)) -> ExchangeRateUploadResponse:
    settings = get_settings()

    if not settings.r2_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='Cloud storage is not configured. Please contact administrator.',
        )

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

    thumb_image = ImageOps.fit(image.copy(), (320, 320), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    image_id = uuid4().hex
    image_name = f'{image_id}.webp'
    thumb_name = f'{image_id}_thumb.webp'

    # Convert images to bytes for R2 upload
    image_buffer = BytesIO()
    image.save(image_buffer, format='WEBP', quality=82, method=6)
    image_bytes = image_buffer.getvalue()

    thumb_buffer = BytesIO()
    thumb_image.save(thumb_buffer, format='WEBP', quality=72, method=6)
    thumb_bytes = thumb_buffer.getvalue()

    # Upload original image to R2
    upload_bytes_to_r2(
        settings,
        image_bytes,
        image_name,
        R2_PROJECT_SLUG,
        R2_IMAGES_FOLDER,
        'image/webp',
    )

    # Upload thumbnail to R2
    upload_bytes_to_r2(
        settings,
        thumb_bytes,
        thumb_name,
        R2_PROJECT_SLUG,
        R2_THUMBS_FOLDER,
        'image/webp',
    )

    uploaded_at = datetime.now(timezone.utc).isoformat()

    return ExchangeRateUploadResponse(
        id=image_id,
        url=_get_r2_image_url(image_name),
        thumbnail_url=_get_r2_thumb_url(thumb_name),
        filename=file.filename or image_name,
        content_type='image/webp',
        size=len(image_bytes),
        uploaded_at=str(uploaded_at),
    )

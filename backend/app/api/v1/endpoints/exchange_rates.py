from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

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


def _exchange_rate_image_dir() -> Path:
    settings = get_settings()
    root = settings.upload_root / 'exchange-rate-notes'
    root.mkdir(parents=True, exist_ok=True)
    (root / 'thumbs').mkdir(parents=True, exist_ok=True)
    return root


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
    image_dir = _exchange_rate_image_dir()
    image_name = f'{image_id}.webp'
    thumb_name = f'{image_id}_thumb.webp'
    image_path = image_dir / image_name
    thumb_path = image_dir / 'thumbs' / thumb_name

    image.save(image_path, format='WEBP', quality=82, method=6)
    thumb_image.save(thumb_path, format='WEBP', quality=72, method=6)

    uploaded_at = datetime.now(timezone.utc).isoformat()

    return ExchangeRateUploadResponse(
        id=image_id,
        url=f'/api/exchange-rates/images/{image_name}',
        thumbnail_url=f'/api/exchange-rates/images/thumbs/{thumb_name}',
        filename=file.filename or image_name,
        content_type='image/webp',
        size=image_path.stat().st_size,
        uploaded_at=str(uploaded_at),
    )


@router.get('/exchange-rates/images/{image_path:path}')
def get_exchange_rate_image(image_path: str) -> Response:
    if not image_path:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid image path')

    root = _exchange_rate_image_dir().resolve()
    resolved = (root / image_path).resolve()
    if not str(resolved).startswith(str(root)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Invalid image path')
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Image not found')

    content_type = CONTENT_TYPE_MAP.get(resolved.suffix.lower(), 'application/octet-stream')
    return Response(
        content=resolved.read_bytes(),
        media_type=content_type,
        headers={'Cache-Control': 'private, max-age=86400'},
    )

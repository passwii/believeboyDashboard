from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from urllib.parse import unquote

from fastapi import HTTPException, status
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models import ExchangeRate
from app.schemas.exchange_rate import ExchangeRateCreate, ExchangeRateNoteImage, ExchangeRateUpdate

RATE_QUANT = Decimal('0.00000001')
RMB_CURRENCY = 'CNY'
COUNTRY_TO_CURRENCY = {
    'US': 'USD',
    'DE': 'EUR',
    'UK': 'GBP',
}


def normalize_year_month(*, year_month: str | None = None, year: int | None = None, month: int | None = None) -> str:
    if year_month:
        normalized = year_month.strip()
        parts = normalized.split('-')
        if len(parts) != 2:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='year_month must be YYYY-MM')
        try:
            parsed_year = int(parts[0])
            parsed_month = int(parts[1])
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='year_month must be YYYY-MM') from None
        year = parsed_year
        month = parsed_month

    if year is None or month is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='year_month or year/month is required')
    if year < 1900 or year > 9999:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='year must be between 1900 and 9999')
    if month < 1 or month > 12:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='month must be between 1 and 12')
    return f'{year}-{month:02d}'


def normalize_rate(value: float | Decimal) -> Decimal:
    try:
        rate = Decimal(str(value)).quantize(RATE_QUANT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='rate must be numeric') from None
    if rate <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail='rate must be > 0')
    return rate


def normalize_note_images(value: list[ExchangeRateNoteImage] | None) -> list[dict[str, object]]:
    if not value:
        return []
    return [item.model_dump(mode='json', by_alias=False) for item in value]


def _normalize_note_image_record(item: object) -> dict[str, object] | None:
    if not isinstance(item, dict):
        return None

    image_id = str(item.get('id') or '').strip()
    url = unquote(str(item.get('url') or '').strip())
    filename = str(item.get('filename') or '').strip()
    if not image_id or not url or not filename:
        return None

    thumbnail_url_raw = item.get('thumbnail_url')
    if thumbnail_url_raw is None:
        thumbnail_url_raw = item.get('thumbnailUrl')

    content_type_raw = item.get('content_type')
    if content_type_raw is None:
        content_type_raw = item.get('contentType')

    uploaded_at_raw = item.get('uploaded_at')
    if uploaded_at_raw is None:
        uploaded_at_raw = item.get('uploadedAt')

    try:
        size = int(item.get('size') or 0)
    except (TypeError, ValueError):
        size = 0

    thumbnail_url = unquote(str(thumbnail_url_raw).strip()) if thumbnail_url_raw else None

    # Repair legacy image paths stored as encoded "thumbs%2Ffile.webp".
    if thumbnail_url and '/api/exchange-rates/images/thumbs%2F' in thumbnail_url:
        thumbnail_url = thumbnail_url.replace('/api/exchange-rates/images/thumbs%2F', '/api/exchange-rates/images/thumbs/')

    return {
        'id': image_id,
        'url': url,
        'thumbnail_url': thumbnail_url,
        'filename': filename,
        'content_type': str(content_type_raw or 'application/octet-stream').strip(),
        'size': max(size, 0),
        'uploaded_at': str(uploaded_at_raw or '1970-01-01T00:00:00+00:00').strip(),
    }


def serialize_note_images(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, object]] = []
    for item in value:
        normalized_item = _normalize_note_image_record(item)
        if normalized_item is None:
            continue
        normalized.append(normalized_item)
    return normalized


def serialize_exchange_rate(row: ExchangeRate) -> dict[str, object]:
    return {
        'id': row.id,
        'currency': row.currency,
        'currency_name': row.currency_name,
        'year_month': row.year_month,
        'rate': float(row.rate),
        'description': row.description,
        'note_images': serialize_note_images(row.note_images),
        'created_at': row.created_at.isoformat() if isinstance(row.created_at, datetime) else str(row.created_at),
        'updated_at': row.updated_at.isoformat() if isinstance(row.updated_at, datetime) else str(row.updated_at),
    }


def resolve_currency_for_country(country: str | None) -> str:
    normalized = (country or '').strip().upper()
    return COUNTRY_TO_CURRENCY.get(normalized, 'USD')


def get_exchange_rate_by_currency_month_with_fallback(
    db: Session,
    *,
    currency: str,
    year_month: str,
) -> ExchangeRate | None:
    normalized_currency = currency.strip().upper()
    normalized_year_month = normalize_year_month(year_month=year_month)

    exact = get_exchange_rate_by_currency_month(db, currency=normalized_currency, year_month=normalized_year_month)
    if exact is not None:
        return exact

    fallback = (
        db.execute(
            select(ExchangeRate)
            .where(
                ExchangeRate.currency == normalized_currency,
                ExchangeRate.year_month <= normalized_year_month,
            )
            .order_by(ExchangeRate.year_month.desc(), ExchangeRate.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if fallback is not None:
        return fallback

    return (
        db.execute(
            select(ExchangeRate)
            .where(ExchangeRate.currency == normalized_currency)
            .order_by(ExchangeRate.year_month.desc(), ExchangeRate.id.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )


def convert_rmb_to_target_currency(
    amount_rmb: Decimal | float | int,
    *,
    country: str | None,
    year_month: str,
    db: Session,
) -> tuple[Decimal, ExchangeRate | None]:
    amount = Decimal(str(amount_rmb or 0))
    target_currency = resolve_currency_for_country(country)
    if target_currency == RMB_CURRENCY:
        return amount, None

    rate_row = get_exchange_rate_by_currency_month_with_fallback(
        db,
        currency=target_currency,
        year_month=year_month,
    )
    if rate_row is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f'{target_currency} exchange rate for {year_month} not found',
        )
    converted = (amount / Decimal(str(rate_row.rate))).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return converted, rate_row


def list_exchange_rates(
    db: Session,
    *,
    currency: str | None,
    year_month: str | None,
    page: int,
    page_size: int,
) -> tuple[list[ExchangeRate], int]:
    stmt: Select = select(ExchangeRate)
    if currency:
        stmt = stmt.where(ExchangeRate.currency == currency.strip())
    if year_month:
        stmt = stmt.where(ExchangeRate.year_month == normalize_year_month(year_month=year_month))

    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = int(db.execute(count_stmt).scalar_one() or 0)
    rows = db.execute(
        stmt.order_by(ExchangeRate.year_month.desc(), ExchangeRate.currency.asc())
        .offset(max(page - 1, 0) * page_size)
        .limit(page_size)
    ).scalars().all()
    return rows, total


def list_exchange_rate_rows(db: Session) -> list[ExchangeRate]:
    return db.execute(select(ExchangeRate).order_by(ExchangeRate.year_month.desc(), ExchangeRate.currency.asc())).scalars().all()


def get_exchange_rate(db: Session, exchange_rate_id: int) -> ExchangeRate | None:
    return db.execute(select(ExchangeRate).where(ExchangeRate.id == exchange_rate_id)).scalars().first()


def get_exchange_rate_by_currency_month(db: Session, *, currency: str, year_month: str) -> ExchangeRate | None:
    return (
        db.execute(
            select(ExchangeRate).where(
                ExchangeRate.currency == currency.strip(),
                ExchangeRate.year_month == normalize_year_month(year_month=year_month),
            )
        )
        .scalars()
        .first()
    )


def create_exchange_rate(db: Session, payload: ExchangeRateCreate) -> ExchangeRate:
    row = ExchangeRate(
        currency=payload.currency.strip(),
        currency_name=(payload.currency_name or '').strip() or None,
        year_month=normalize_year_month(year_month=payload.year_month, year=payload.year, month=payload.month),
        rate=normalize_rate(payload.rate),
        description=(payload.description or '').strip() or None,
        note_images=normalize_note_images(payload.note_images),
    )
    db.add(row)
    db.flush()
    db.refresh(row)
    return row


def update_exchange_rate(db: Session, row: ExchangeRate, payload: ExchangeRateUpdate) -> ExchangeRate:
    if payload.currency is not None:
        row.currency = payload.currency.strip()
    if payload.currency_name is not None:
        row.currency_name = payload.currency_name.strip() or None
    if payload.year_month is not None or payload.year is not None or payload.month is not None:
        current_year, current_month = row.year_month.split('-')
        row.year_month = normalize_year_month(
            year_month=payload.year_month,
            year=payload.year if payload.year is not None else int(current_year),
            month=payload.month if payload.month is not None else int(current_month),
        )
    if payload.rate is not None:
        row.rate = normalize_rate(payload.rate)
    if payload.description is not None:
        row.description = payload.description.strip() or None
    if payload.note_images is not None:
        row.note_images = normalize_note_images(payload.note_images)
    db.flush()
    db.refresh(row)
    return row


def delete_exchange_rate(db: Session, row: ExchangeRate) -> None:
    db.delete(row)
    db.flush()

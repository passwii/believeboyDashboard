"""Extracted function from ad_analysis_service.py (stage 3 refactor)."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.utils.country import normalize_country
from .helpers import _build_purchased_product_items, _ensure_project_access, _matches_dimension, _normalize_dimension
from .loaders import _load_purchased_product_rows
def build_purchased_products(
    db: Session,
    *,
    project_id: int,
    country: str,
    date_from: date | None = None,
    date_to: date | None = None,
    campaign: str | None = None,
    sku: str | None = None,
    purchased_asin: str | None = None,
    operator: str | None = None,
    is_admin: bool = True,
) -> dict[str, object]:
    _ensure_project_access(db, project_id=project_id, operator=operator, is_admin=is_admin)
    normalized_country = normalize_country(country)
    rows = _load_purchased_product_rows(
        db,
        project_id=project_id,
        country=normalized_country,
        date_from=date_from,
        date_to=date_to,
        campaign=campaign,
    )
    normalized_sku = _normalize_dimension(sku)
    normalized_purchased_asin = _normalize_dimension(purchased_asin)
    rows = [
        row
        for row in rows
        if _matches_dimension(row.ad_sku, normalized_sku)
        and _matches_dimension(row.purchased_asin, normalized_purchased_asin)
    ]
    return {
        'project_id': project_id,
        'country': normalized_country,
        'items': _build_purchased_product_items(rows),
    }

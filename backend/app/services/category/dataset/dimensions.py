"""Dimension management functions."""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.models import CategoryResearchDataset, CategoryResearchProductDetail


def upsert_manual_dimensions(
    db: Session,
    *,
    dataset_id: int,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """Update manual dimension values for products in a dataset."""
    from app.services.category.dataset_parsers import _normalize_dimension_key, _normalize_dimension_value

    if db.get(CategoryResearchDataset, dataset_id) is None:
        raise ValueError('Dataset not found')
    if not items:
        return {'dataset_id': dataset_id, 'updated_count': 0}

    row_ids = sorted({int(item.get('product_row_id') or 0) for item in items if int(item.get('product_row_id') or 0) > 0})
    if not row_ids:
        raise ValueError('items.product_row_id is required')

    rows = list(
        db.execute(
            select(CategoryResearchProductDetail).where(
                CategoryResearchProductDetail.dataset_id == dataset_id,
                CategoryResearchProductDetail.id.in_(row_ids),
            )
        ).scalars().all()
    )
    row_map = {int(row.id): row for row in rows}
    updated_row_ids: set[int] = set()

    for item in items:
        row_id = int(item.get('product_row_id') or 0)
        row = row_map.get(row_id)
        if row is None:
            raise ValueError(f'product_row_id not found in dataset: {row_id}')

        key = _normalize_dimension_key(str(item.get('key') or ''))
        if not key:
            raise ValueError('dimension key is required')
        value = _normalize_dimension_value(item.get('value'))

        manual = _normalize_dimension_map(row.manual_dimensions)
        if value is None:
            manual.pop(key, None)
        else:
            manual[key] = value
        row.manual_dimensions = manual
        updated_row_ids.add(row_id)

    db.commit()
    return {'dataset_id': dataset_id, 'updated_count': len(updated_row_ids)}


def normalize_dimension_map(payload: Any) -> dict[str, str]:
    """Normalize a dimension map payload."""
    return _normalize_dimension_map(payload)


def effective_dimensions(row: CategoryResearchProductDetail) -> dict[str, str]:
    """Get effective dimensions for a product row (extracted + manual)."""
    return _effective_dimensions(row)


# --- Internal Helper Functions ---

def _normalize_dimension_map(payload: Any) -> dict[str, str]:
    """Normalize a dimension map from various input formats."""
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return {str(k): str(v) if v is not None else '' for k, v in payload.items()}
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                return {str(k): str(v) if v is not None else '' for k, v in parsed.items()}
        except (json.JSONDecodeError, TypeError):
            pass
    return {}


def _effective_dimensions(row: CategoryResearchProductDetail) -> dict[str, str]:
    """Get effective dimensions (extracted + manual)."""
    result = dict(row.extracted_dimensions or {})
    for key, value in (row.manual_dimensions or {}).items():
        if value:
            result[key] = value
        else:
            result.pop(key, None)
    return result
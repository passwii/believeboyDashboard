"""Data management - SKU info batch operations service."""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.sku_info import SkuRecord


def get_sku_records_by_ids(
    db: Session,
    ids: list[int],
) -> list[SkuRecord]:
    """Query SKU records by a list of IDs.

    Args:
        db: Database session.
        ids: List of SKU record IDs to query.

    Returns:
        List of SkuRecord objects matching the given IDs.
    """
    if not ids:
        return []

    stmt = select(SkuRecord).where(SkuRecord.id.in_(ids))
    rows = db.execute(stmt).scalars().all()
    return list(rows)


def batch_update_factory_info(
    db: Session,
    updates: list[dict[str, Any]],
    operator: str | None = None,
) -> tuple[int, int]:
    """Batch update SKU factory info for multiple records.

    Args:
        db: Database session.
        updates: List of dicts, each containing:
            - id (required): SKU record ID
            - sku_factory_info (optional): factory info data to set
        operator: Username of the operator performing the update.

    Returns:
        Tuple of (updated_count, skipped_count).
    """
    if not updates:
        return 0, 0

    ids = [u["id"] for u in updates if "id" in u]
    if not ids:
        return 0, 0

    records = get_sku_records_by_ids(db, ids)
    record_map = {r.id: r for r in records}

    updated_count = 0
    skipped_count = 0
    now = datetime.now(timezone.utc)

    for update in updates:
        record_id = update.get("id")
        if record_id is None:
            skipped_count += 1
            continue

        record = record_map.get(record_id)
        if record is None:
            skipped_count += 1
            continue

        factory_info = update.get("sku_factory_info")
        if factory_info is not None:
            record.sku_factory_info = factory_info
            record.sku_factory_info_updated_at = now
            if operator:
                record.sku_factory_info_updated_by = operator
            updated_count += 1
        else:
            skipped_count += 1

    db.flush()
    return updated_count, skipped_count
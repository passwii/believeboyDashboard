"""Data management - SKU info batch operations service."""

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.sku_info import SkuRecord
from app.schemas.sku_info import LISTING_COPY_FIELDS


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

    # 内联 select：避免中间变量让静态扫描无法确认参数化（.in_ 本身即参数化）
    rows = (
        db.execute(select(SkuRecord).where(SkuRecord.id.in_(ids))).scalars().all()
    )
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

def batch_update_listing_copy(
    db: Session,
    updates: list[dict[str, Any]],
    operator: str | None = None,
) -> tuple[int, int, list[int]]:
    """批量更新 SKU 产品文案（BLF-1080，spec §3.2）。

    语义对齐 ``batch_update_factory_info``：

    * 未知 / 缺失 id → 计入 skipped（不整批失败）；
    * 文案字段按 ``updates`` 里**实际出现的 key** 判定（调用方用
      ``model_fields_set`` 构造）——未提供的字段保持原值，显式 ``None`` 清空；
    * 任一条有实际写入 → 刷新 ``listing_copy_updated_at`` /
      ``listing_copy_updated_by``。

    Returns:
        ``(updated_count, skipped_count, updated_ids)``
    """
    if not updates:
        return 0, 0, []

    ids = [u["id"] for u in updates if "id" in u]
    if not ids:
        return 0, 0, []

    records = get_sku_records_by_ids(db, ids)
    record_map = {r.id: r for r in records}

    updated_count = 0
    skipped_count = 0
    updated_ids: list[int] = []
    now = datetime.now(timezone.utc)

    for update in updates:
        record_id = update.get("id")
        record = record_map.get(record_id) if isinstance(record_id, int) else None
        if record is None:
            skipped_count += 1
            continue

        changed = False
        for field in LISTING_COPY_FIELDS:
            if field not in update:
                continue
            value = update[field]
            # 空串与 None 等价（均表示未填写 / 清空），避免 "" 与 NULL 双态
            normalized = value.strip() if isinstance(value, str) else value
            if isinstance(normalized, str) and normalized == "":
                normalized = None
            if getattr(record, field) != normalized:
                setattr(record, field, normalized)
                changed = True

        if not changed:
            skipped_count += 1
            continue

        record.listing_copy_updated_at = now
        record.listing_copy_updated_by = operator
        updated_count += 1
        updated_ids.append(record.id)

    db.flush()
    return updated_count, skipped_count, updated_ids

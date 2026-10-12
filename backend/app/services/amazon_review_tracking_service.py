from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.amazon_review_tracking import AmazonReviewGroup, AmazonReviewGroupMember
from app.models.sku_info import SkuRecord
from app.schemas.amazon_review_tracking import SUPPORTED_MARKETPLACES, validate_marketplace


class ReviewGroupError(ValueError):
    """Invalid review-group operation or input."""


def _validate_members(db: Session, ids: list[int], project_id: int, marketplace: str) -> dict[int, SkuRecord]:
    if not ids:
        raise ReviewGroupError("at least one member SKU is required")
    if len(set(ids)) != len(ids):
        raise ReviewGroupError("duplicate member IDs")
    records = db.execute(select(SkuRecord).where(SkuRecord.id.in_(ids))).scalars().all()
    by_id = {record.id: record for record in records}
    if len(by_id) != len(ids):
        raise ReviewGroupError("unknown SKU record")
    if any(record.project_id != project_id or record.country != marketplace for record in records):
        raise ReviewGroupError("SKU must belong to the same Project and Marketplace")
    return by_id


def _checked_marketplace(marketplace: str) -> str:
    try:
        return validate_marketplace(marketplace)
    except ValueError as exc:
        raise ReviewGroupError("invalid Marketplace") from exc


def _active_group(db: Session, group_id: int) -> AmazonReviewGroup:
    group = db.execute(select(AmazonReviewGroup).where(AmazonReviewGroup.id == group_id).with_for_update()).scalar_one_or_none()
    if group is None:
        raise ReviewGroupError("review group not found")
    if not group.is_active:
        raise ReviewGroupError("cannot modify inactive review group")
    return group


def _add_members(db: Session, group: AmazonReviewGroup, ids: list[int]) -> None:
    current = db.execute(select(AmazonReviewGroupMember).where(
        AmazonReviewGroupMember.group_id == group.id,
        AmazonReviewGroupMember.removed_at.is_(None),
    )).scalars().all()
    current_by_sku = {member.sku_record_id: member for member in current}
    wanted = set(ids)
    now = datetime.now(timezone.utc)
    for member in current:
        if member.sku_record_id not in wanted:
            member.removed_at = now
    for sku_id in ids:
        if sku_id not in current_by_sku:
            db.add(AmazonReviewGroupMember(
                group_id=group.id, project_id=group.project_id,
                marketplace=group.marketplace, sku_record_id=sku_id,
            ))


def create_group(db: Session, *, project_id: int, marketplace: str, name: str, member_ids: list[int], representative_id: int, description: str | None = None) -> AmazonReviewGroup:
    marketplace = _checked_marketplace(marketplace)
    name = name.strip()
    if not name:
        raise ReviewGroupError("name must not be blank")
    if len(name) > 255:
        raise ReviewGroupError("name exceeds 255 characters")
    if len(set(member_ids)) != len(member_ids):
        raise ReviewGroupError("duplicate member IDs")
    _validate_members(db, member_ids, project_id, marketplace)
    if representative_id not in member_ids:
        raise ReviewGroupError("representative must be a member")
    duplicate = db.execute(select(AmazonReviewGroup.id).where(
        AmazonReviewGroup.project_id == project_id,
        AmazonReviewGroup.marketplace == marketplace,
        AmazonReviewGroup.name == name,
        AmazonReviewGroup.is_active.is_(True),
    )).first()
    if duplicate:
        raise ReviewGroupError("active review group with this name already exists")
    group = AmazonReviewGroup(project_id=project_id, marketplace=marketplace, name=name,
        description=description, representative_sku_record_id=representative_id, is_active=True)
    db.add(group)
    try:
        with db.begin_nested():
            db.flush()
            _add_members(db, group, member_ids)
            db.flush()
    except IntegrityError as exc:
        raise ReviewGroupError("SKU already belongs to an active review group or violates group ownership") from exc
    return group


def replace_group_members(db: Session, *, group_id: int, member_ids: list[int]) -> AmazonReviewGroup:
    group = _active_group(db, group_id)
    if len(set(member_ids)) != len(member_ids):
        raise ReviewGroupError("duplicate member IDs")
    _validate_members(db, member_ids, group.project_id, group.marketplace)
    if group.representative_sku_record_id not in member_ids:
        raise ReviewGroupError("representative must remain a group member; set representative first")
    try:
        with db.begin_nested():
            _add_members(db, group, member_ids)
            db.flush()
    except IntegrityError as exc:
        raise ReviewGroupError("SKU already belongs to an active review group or violates group ownership") from exc
    return group


def set_representative(db: Session, *, group_id: int, sku_record_id: int) -> AmazonReviewGroup:
    group = _active_group(db, group_id)
    sku = db.execute(select(SkuRecord).where(SkuRecord.id == sku_record_id)).scalar_one_or_none()
    if sku is None or sku.project_id != group.project_id or sku.country != group.marketplace:
        raise ReviewGroupError("representative SKU must belong to the same Project and Marketplace")
    member = db.execute(select(AmazonReviewGroupMember.id).where(
        AmazonReviewGroupMember.group_id == group.id,
        AmazonReviewGroupMember.sku_record_id == sku_record_id,
        AmazonReviewGroupMember.removed_at.is_(None),
    )).first()
    if member is None:
        raise ReviewGroupError("representative must be an active group member")
    group.representative_sku_record_id = sku_record_id
    db.flush()
    return group


def deactivate_group(db: Session, *, group_id: int) -> AmazonReviewGroup:
    group = _active_group(db, group_id)
    group.is_active = False
    db.flush()
    return group

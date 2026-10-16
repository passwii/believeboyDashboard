from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.amazon_review_tracking import (
    AmazonReviewExternalLink,
    AmazonReviewTarget,
)
from app.models.project_shop import ProjectShop
from app.schemas.amazon_review_tracking import validate_marketplace

_ASIN_PATTERN = re.compile(r"^[A-Z0-9]{10}$")


class ExternalLinkError(ValueError):
    """Invalid external competitor operation."""


def _require_shop(db: Session, shop_id: int) -> ProjectShop:
    shop = db.get(ProjectShop, shop_id)
    if shop is None:
        raise ExternalLinkError("shop not found")
    return shop


def _find_target(db: Session, marketplace: str, asin: str) -> AmazonReviewTarget | None:
    return db.execute(
        select(AmazonReviewTarget).where(
            AmazonReviewTarget.kind == "external_asin",
            AmazonReviewTarget.marketplace == marketplace,
            AmazonReviewTarget.asin == asin,
        )
    ).scalar_one_or_none()


def _find_link(db: Session, target_id: int, shop_id: int) -> AmazonReviewExternalLink | None:
    return db.execute(
        select(AmazonReviewExternalLink).where(
            AmazonReviewExternalLink.target_id == target_id,
            AmazonReviewExternalLink.shop_id == shop_id,
        )
    ).scalar_one_or_none()


def _normalize_display_name(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _upsert_link(db: Session, target_id: int, shop_id: int) -> AmazonReviewExternalLink:
    now = datetime.now(timezone.utc)
    link = _find_link(db, target_id, shop_id)
    if link is None:
        link = AmazonReviewExternalLink(target_id=target_id, shop_id=shop_id, is_active=True, added_at=now)
        db.add(link)
        try:
            with db.begin_nested():
                db.flush()
        except IntegrityError:
            # 并发下另一方先插入 (target_id, shop_id)：回滚 savepoint 后复用既有行。
            if link in db:
                db.expunge(link)
            link = _find_link(db, target_id, shop_id)
            if link is None:
                raise
    link.is_active = True
    link.removed_at = None
    link.added_at = now
    db.flush()
    return link


def register_external_target(db: Session, *, marketplace: str, asin: str, shop_id: int | None = None,
                             display_name: str | None = None) -> AmazonReviewTarget:
    try:
        marketplace = validate_marketplace(marketplace)
    except ValueError as exc:
        raise ExternalLinkError("invalid Marketplace") from exc
    asin = asin.strip().upper()
    if not asin:
        raise ExternalLinkError("asin must not be blank")
    if not _ASIN_PATTERN.fullmatch(asin):
        raise ExternalLinkError("asin must be 10 alphanumeric characters")
    display_name = _normalize_display_name(display_name)
    target = _find_target(db, marketplace, asin)
    if target is None:
        target = AmazonReviewTarget(kind="external_asin", marketplace=marketplace, asin=asin,
                                    display_name=display_name or asin, is_active=True)
        db.add(target)
        try:
            with db.begin_nested():
                db.flush()
        except IntegrityError:
            # 并发下另一方先插入 (kind, marketplace, asin)：回滚 savepoint 后复用既有行。
            if target in db:
                db.expunge(target)
            target = _find_target(db, marketplace, asin)
            if target is None:
                raise
    target.is_active = True
    if display_name is not None:
        target.display_name = display_name
    if shop_id is not None:
        _require_shop(db, shop_id)
        _upsert_link(db, target.id, shop_id)
    return target


def add_external_link(db: Session, *, target_id: int, shop_id: int) -> AmazonReviewExternalLink:
    target = db.get(AmazonReviewTarget, target_id)
    if target is None or target.kind != "external_asin":
        raise ExternalLinkError("external target not found")
    _require_shop(db, shop_id)
    return _upsert_link(db, target_id, shop_id)


def remove_external_link(db: Session, *, target_id: int, link_id: int) -> AmazonReviewExternalLink:
    link = db.get(AmazonReviewExternalLink, link_id)
    if link is None or link.target_id != target_id:
        raise ExternalLinkError("external link not found")
    link.is_active = False
    link.removed_at = datetime.now(timezone.utc)
    db.flush()
    return link


def links_by_target(db: Session, target_ids: list[int]) -> dict[int, list[AmazonReviewExternalLink]]:
    """批量查链接，避免逐 target 查询（N+1）。"""
    if not target_ids:
        return {}
    rows = db.execute(
        select(AmazonReviewExternalLink)
        .where(AmazonReviewExternalLink.target_id.in_(target_ids))
        .order_by(AmazonReviewExternalLink.id)
    ).scalars().all()
    grouped: dict[int, list[AmazonReviewExternalLink]] = {}
    for row in rows:
        grouped.setdefault(row.target_id, []).append(row)
    return grouped


def links_for_target(db: Session, target_id: int) -> list[AmazonReviewExternalLink]:
    return links_by_target(db, [target_id]).get(target_id, [])

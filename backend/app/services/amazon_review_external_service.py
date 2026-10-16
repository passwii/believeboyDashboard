from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.amazon_review_tracking import (
    AmazonReviewExternalLink,
    AmazonReviewTarget,
)
from app.models.project_shop import ProjectShop
from app.schemas.amazon_review_tracking import validate_marketplace


class ExternalLinkError(ValueError):
    """Invalid external competitor operation."""


def _require_shop(db: Session, shop_id: int) -> ProjectShop:
    shop = db.get(ProjectShop, shop_id)
    if shop is None:
        raise ExternalLinkError("shop not found")
    return shop


def _upsert_link(db: Session, target_id: int, shop_id: int) -> AmazonReviewExternalLink:
    now = datetime.now(timezone.utc)
    link = db.execute(
        select(AmazonReviewExternalLink).where(
            AmazonReviewExternalLink.target_id == target_id,
            AmazonReviewExternalLink.shop_id == shop_id,
        )
    ).scalar_one_or_none()
    if link is None:
        link = AmazonReviewExternalLink(target_id=target_id, shop_id=shop_id, is_active=True, added_at=now)
        db.add(link)
    else:
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
    target = db.execute(
        select(AmazonReviewTarget).where(
            AmazonReviewTarget.kind == "external_asin",
            AmazonReviewTarget.marketplace == marketplace,
            AmazonReviewTarget.asin == asin,
        )
    ).scalar_one_or_none()
    if target is None:
        target = AmazonReviewTarget(kind="external_asin", marketplace=marketplace, asin=asin,
                                    display_name=display_name or asin, is_active=True)
        db.add(target)
        db.flush()
    elif display_name is not None:
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


def links_for_target(db: Session, target_id: int) -> list[AmazonReviewExternalLink]:
    return list(db.execute(
        select(AmazonReviewExternalLink)
        .where(AmazonReviewExternalLink.target_id == target_id)
        .order_by(AmazonReviewExternalLink.id)
    ).scalars().all())

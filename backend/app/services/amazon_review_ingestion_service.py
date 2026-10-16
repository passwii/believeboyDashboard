from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal, Sequence
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewTarget,
)

BUSINESS_TZ = ZoneInfo("Asia/Shanghai")

CaptureStatus = Literal["success", "partial", "failed"]
StarCountQuality = Literal["exact", "estimated", "unavailable"]
IdConfidence = Literal["original", "derived"]


class IngestionError(ValueError):
    """Invalid crawl submission."""


@dataclass(frozen=True)
class RatingCapture:
    average_rating: float | None = None
    rating_count: int | None = None
    review_count: int | None = None
    star_percentages: Sequence[float] | None = None  # 1..5 星百分比
    star_counts: Sequence[int] | None = None         # 1..5 星绝对数
    star_count_quality: StarCountQuality = "unavailable"


@dataclass(frozen=True)
class ReviewCapture:
    review_key: str
    id_confidence: IdConfidence
    rating: int | None = None
    title: str | None = None
    body: str | None = None
    reviewer_id: str | None = None
    reviewer_name: str | None = None
    review_date: date | None = None
    verified_purchase: bool | None = None
    helpful_count: int | None = None


@dataclass(frozen=True)
class CrawlResult:
    target_id: int
    run_id: int
    capture_date: date
    snapshot_updated: bool
    reviews_upserted: int
    reviews_suspected_removed: int


def business_date(captured_at: datetime) -> date:
    return captured_at.astimezone(BUSINESS_TZ).date()


def _existing_run(db: Session, target_id: int, idempotency_key: str | None) -> AmazonReviewCrawlRun | None:
    if idempotency_key is None:
        return None
    return db.execute(
        select(AmazonReviewCrawlRun).where(
            AmazonReviewCrawlRun.target_id == target_id,
            AmazonReviewCrawlRun.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()


def _upsert_snapshot(
    db: Session, target_id: int, capture_date: date, captured_at: datetime,
    rating: RatingCapture, status: CaptureStatus, source: str | None,
) -> None:
    snapshot = db.execute(
        select(AmazonReviewRatingSnapshot).where(
            AmazonReviewRatingSnapshot.target_id == target_id,
            AmazonReviewRatingSnapshot.capture_date == capture_date,
        )
    ).scalar_one_or_none()
    if snapshot is None:
        snapshot = AmazonReviewRatingSnapshot(target_id=target_id, capture_date=capture_date)
        db.add(snapshot)
    snapshot.captured_at = captured_at
    snapshot.average_rating = rating.average_rating
    snapshot.rating_count = rating.rating_count
    snapshot.review_count = rating.review_count
    percentages = list(rating.star_percentages) if rating.star_percentages is not None else [None] * 5
    counts = list(rating.star_counts) if rating.star_counts is not None else [None] * 5
    for idx in range(5):
        setattr(snapshot, f"star_{idx + 1}_percentage", percentages[idx])
        setattr(snapshot, f"star_{idx + 1}_count", counts[idx])
    snapshot.star_count_quality = rating.star_count_quality
    snapshot.capture_status = status
    snapshot.source = source
    db.flush()


def _upsert_review(db: Session, target_id: int, item: ReviewCapture, seen_at: datetime) -> None:
    row = db.execute(
        select(AmazonReviewReview).where(
            AmazonReviewReview.target_id == target_id,
            AmazonReviewReview.review_key == item.review_key,
        )
    ).scalar_one_or_none()
    if row is None:
        row = AmazonReviewReview(
            target_id=target_id, review_key=item.review_key, id_confidence=item.id_confidence,
            first_seen_at=seen_at, last_seen_at=seen_at,
            visibility_status="visible", missing_streak=0,
        )
        db.add(row)
    else:
        row.id_confidence = item.id_confidence
        row.last_seen_at = seen_at
        row.missing_streak = 0
        row.visibility_status = "visible"
    row.rating = item.rating
    row.title = item.title
    row.body = item.body
    row.reviewer_id = item.reviewer_id
    row.reviewer_name = item.reviewer_name
    row.review_date = item.review_date
    row.verified_purchase = item.verified_purchase
    row.helpful_count = item.helpful_count


def _apply_missing(db: Session, target_id: int, seen_keys: set[str]) -> int:
    suspects = 0
    rows = db.execute(
        select(AmazonReviewReview).where(
            AmazonReviewReview.target_id == target_id,
            AmazonReviewReview.visibility_status == "visible",
        )
    ).scalars().all()
    for row in rows:
        if row.review_key in seen_keys:
            continue
        row.missing_streak += 1
        if row.missing_streak >= 2:
            row.visibility_status = "suspected_removed"
            suspects += 1
    return suspects


def record_crawl_result(
    db: Session, *, target_id: int, captured_at: datetime, status: CaptureStatus,
    rating: RatingCapture | None = None, reviews: Sequence[ReviewCapture] | None = None,
    is_complete_list: bool = False, idempotency_key: str | None = None,
    asin_scraped: str | None = None, source: str | None = None,
    error_message: str | None = None, capture_date: date | None = None,
) -> CrawlResult:
    target = db.get(AmazonReviewTarget, target_id)
    if target is None:
        raise IngestionError("target not found")

    existing = _existing_run(db, target_id, idempotency_key)
    if existing is not None:
        return CrawlResult(
            target_id=target_id, run_id=existing.id,
            capture_date=capture_date or business_date(captured_at),
            snapshot_updated=False, reviews_upserted=0, reviews_suspected_removed=0,
        )

    effective_date = capture_date or business_date(captured_at)
    run = AmazonReviewCrawlRun(
        target_id=target_id, idempotency_key=idempotency_key, started_at=captured_at,
        finished_at=captured_at, status=status, is_complete_list=is_complete_list,
        reviews_seen=(len(reviews) if reviews is not None else None),
        ratings_captured=rating is not None, asin_scraped=asin_scraped, error_message=error_message,
    )
    db.add(run)
    db.flush()

    snapshot_updated = False
    if rating is not None and status != "failed":
        _upsert_snapshot(db, target_id, effective_date, captured_at, rating, status, source)
        snapshot_updated = True

    upserted = 0
    suspects = 0
    if reviews is not None and status != "failed":
        seen_keys: set[str] = set()
        for item in reviews:
            seen_keys.add(item.review_key)
            _upsert_review(db, target_id, item, captured_at)
            upserted += 1
        if is_complete_list and status == "success":
            suspects = _apply_missing(db, target_id, seen_keys)
        db.flush()

    return CrawlResult(
        target_id=target_id, run_id=run.id, capture_date=effective_date,
        snapshot_updated=snapshot_updated, reviews_upserted=upserted,
        reviews_suspected_removed=suspects,
    )

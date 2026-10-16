from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
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


def _is_integral(value: float | int) -> bool:
    return math.isfinite(value) and float(value).is_integer()


def _validate_capture(
    captured_at: datetime, rating: RatingCapture | None,
    reviews: Sequence[ReviewCapture] | None, status: CaptureStatus,
) -> None:
    if status not in ("success", "partial", "failed"):
        raise IngestionError(f"invalid status: {status}")
    if captured_at.tzinfo is None or captured_at.utcoffset() is None:
        raise IngestionError("captured_at must be timezone-aware")
    if rating is not None:
        if rating.star_count_quality not in ("exact", "estimated", "unavailable"):
            raise IngestionError(f"invalid star_count_quality: {rating.star_count_quality}")
        if rating.average_rating is not None and (
            not math.isfinite(rating.average_rating) or not 0 <= rating.average_rating <= 5
        ):
            raise IngestionError("average_rating must be a finite number between 0 and 5")
        if rating.rating_count is not None and not (_is_integral(rating.rating_count) and rating.rating_count >= 0):
            raise IngestionError("rating_count must be a non-negative integer")
        if rating.review_count is not None and not (_is_integral(rating.review_count) and rating.review_count >= 0):
            raise IngestionError("review_count must be a non-negative integer")
        for label, values in (("star_percentages", rating.star_percentages), ("star_counts", rating.star_counts)):
            if values is not None and len(values) != 5:
                raise IngestionError(f"{label} must contain exactly 5 values")
        if rating.star_percentages is not None and any(
            not math.isfinite(p) or p < 0 or p > 100 for p in rating.star_percentages
        ):
            raise IngestionError("star_percentages values must be finite numbers between 0 and 100")
        if rating.star_counts is not None and any(not (_is_integral(c) and c >= 0) for c in rating.star_counts):
            raise IngestionError("star_counts values must be non-negative integers")
    if reviews is not None:
        for item in reviews:
            if item.id_confidence not in ("original", "derived"):
                raise IngestionError(f"invalid id_confidence: {item.id_confidence}")
            if item.rating is not None and not (_is_integral(item.rating) and 1 <= item.rating <= 5):
                raise IngestionError("review rating must be an integer between 1 and 5")
            if item.helpful_count is not None and not (_is_integral(item.helpful_count) and item.helpful_count >= 0):
                raise IngestionError("helpful_count must be a non-negative integer")


def _existing_run(db: Session, target_id: int, idempotency_key: str | None) -> AmazonReviewCrawlRun | None:
    if idempotency_key is None:
        return None
    return db.execute(
        select(AmazonReviewCrawlRun).where(
            AmazonReviewCrawlRun.target_id == target_id,
            AmazonReviewCrawlRun.idempotency_key == idempotency_key,
        )
    ).scalar_one_or_none()


def _find_snapshot(db: Session, target_id: int, capture_date: date) -> AmazonReviewRatingSnapshot | None:
    return db.execute(
        select(AmazonReviewRatingSnapshot).where(
            AmazonReviewRatingSnapshot.target_id == target_id,
            AmazonReviewRatingSnapshot.capture_date == capture_date,
        )
    ).scalar_one_or_none()


def _apply_snapshot_fields(
    snapshot: AmazonReviewRatingSnapshot, captured_at: datetime,
    rating: RatingCapture, status: CaptureStatus, source: str | None,
) -> None:
    snapshot.captured_at = captured_at
    snapshot.average_rating = Decimal(str(rating.average_rating)) if rating.average_rating is not None else None
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


def _upsert_snapshot(
    db: Session, target_id: int, capture_date: date, captured_at: datetime,
    rating: RatingCapture, status: CaptureStatus, source: str | None,
) -> None:
    snapshot = _find_snapshot(db, target_id, capture_date)
    if snapshot is None:
        try:
            with db.begin_nested():
                snapshot = AmazonReviewRatingSnapshot(target_id=target_id, capture_date=capture_date)
                _apply_snapshot_fields(snapshot, captured_at, rating, status, source)
                db.add(snapshot)
                db.flush()
        except IntegrityError:
            # 并发下另一方先插入 (target_id, capture_date)：savepoint 只回滚本次插入，随后复用既有行。
            if snapshot in db:
                db.expunge(snapshot)
            snapshot = _find_snapshot(db, target_id, capture_date)
            if snapshot is None:
                raise
    _apply_snapshot_fields(snapshot, captured_at, rating, status, source)
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
    _validate_capture(captured_at, rating, reviews, status)
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
    try:
        with db.begin_nested():
            db.add(run)
            db.flush()
    except IntegrityError:
        # 并发下另一方先提交相同 (target_id, idempotency_key)：savepoint 只回滚本次插入，
        # 命中既有 run 即视为幂等 noop；仍查不到才说明是真实约束错误。
        if run in db:
            db.expunge(run)
        existing = _existing_run(db, target_id, idempotency_key)
        if existing is not None:
            return CrawlResult(
                target_id=target_id, run_id=existing.id, capture_date=effective_date,
                snapshot_updated=False, reviews_upserted=0, reviews_suspected_removed=0,
            )
        raise

    snapshot_updated = False
    if rating is not None and status != "failed":
        _upsert_snapshot(db, target_id, effective_date, captured_at, rating, status, source)
        snapshot_updated = True

    upserted = 0
    suspects = 0
    if reviews is not None and status != "failed":
        deduped: dict[str, ReviewCapture] = {}
        for item in reviews:
            deduped[item.review_key] = item
        seen_keys = set(deduped)
        for item in deduped.values():
            _upsert_review(db, target_id, item, captured_at)
        upserted = len(deduped)
        if is_complete_list and status == "success":
            suspects = _apply_missing(db, target_id, seen_keys)
        db.flush()

    return CrawlResult(
        target_id=target_id, run_id=run.id, capture_date=effective_date,
        snapshot_updated=snapshot_updated, reviews_upserted=upserted,
        reviews_suspected_removed=suspects,
    )

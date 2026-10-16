from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models import Project, SkuRecord
from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewTarget,
)
from app.services.amazon_review_ingestion_service import (
    IngestionError,
    RatingCapture,
    ReviewCapture,
    record_crawl_result,
)
from app.services.amazon_review_tracking_service import create_group


@pytest.fixture
def target(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    sku = SkuRecord(
        project_id=project.id, project_name=project.project_name,
        sku=f"ingest-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=920000, is_active=True,
    )
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US",
        name=f"Ing-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    return db_session.execute(
        select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
    ).scalar_one()


def _now(days_ago: int = 0) -> datetime:
    return datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc) - timedelta(days=days_ago)


def _review(key: str, **kw) -> ReviewCapture:
    return ReviewCapture(review_key=key, id_confidence="original", rating=5, **kw)


def test_first_run_writes_snapshot_reviews_and_run(db_session, target):
    result = record_crawl_result(
        db_session, target_id=target.id, captured_at=_now(), status="success",
        rating=RatingCapture(average_rating=4.5, rating_count=10, review_count=2,
                             star_percentages=(10, 10, 10, 20, 50), star_count_quality="estimated"),
        reviews=[_review("R1"), _review("R2")],
        is_complete_list=True, asin_scraped=target.asin,
    )
    db_session.flush()
    snap = db_session.execute(select(AmazonReviewRatingSnapshot)).scalar_one()
    assert snap.capture_date == date(2026, 10, 20)
    assert float(snap.average_rating) == 4.5 and snap.rating_count == 10 and snap.review_count == 2
    assert float(snap.star_5_percentage) == 50
    assert len(db_session.execute(select(AmazonReviewReview)).scalars().all()) == 2
    assert result.reviews_upserted == 2
    run = db_session.execute(select(AmazonReviewCrawlRun)).scalar_one()
    assert run.status == "success" and run.is_complete_list is True and run.ratings_captured is True


def test_same_day_retry_updates_snapshot_but_keeps_runs(db_session, target):
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                        rating=RatingCapture(average_rating=4.5, rating_count=10))
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                        rating=RatingCapture(average_rating=4.6, rating_count=11))
    db_session.flush()
    snaps = db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all()
    assert len(snaps) == 1 and float(snaps[0].average_rating) == 4.6
    assert len(db_session.execute(select(AmazonReviewCrawlRun)).scalars().all()) == 2


def test_idempotency_key_noop(db_session, target):
    kw = dict(target_id=target.id, captured_at=_now(), status="success",
              rating=RatingCapture(average_rating=4.5, rating_count=10),
              reviews=[_review("R1")], is_complete_list=True, idempotency_key="k-1")
    record_crawl_result(db_session, **kw)
    record_crawl_result(db_session, **kw)
    db_session.flush()
    assert len(db_session.execute(select(AmazonReviewCrawlRun)).scalars().all()) == 1
    assert len(db_session.execute(select(AmazonReviewReview)).scalars().all()) == 1


def test_two_complete_misses_mark_suspected_removed_then_reappear_restores(db_session, target):
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(2), status="success",
                        reviews=[_review("R1")], is_complete_list=True)
    db_session.flush()
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(1), status="success",
                        reviews=[], is_complete_list=True)
    db_session.flush()
    row = db_session.execute(select(AmazonReviewReview)).scalar_one()
    assert row.visibility_status == "visible" and row.missing_streak == 1

    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                        reviews=[], is_complete_list=True)
    db_session.flush()
    db_session.refresh(row)
    assert row.visibility_status == "suspected_removed" and row.missing_streak == 2

    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                        reviews=[_review("R1")], is_complete_list=True)
    db_session.flush()
    db_session.refresh(row)
    assert row.visibility_status == "visible" and row.missing_streak == 0


def test_incomplete_run_does_not_change_visibility(db_session, target):
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(1), status="success",
                        reviews=[_review("R1")], is_complete_list=True)
    db_session.flush()
    for _ in range(3):
        record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="partial",
                            reviews=[], is_complete_list=False)
    db_session.flush()
    row = db_session.execute(select(AmazonReviewReview)).scalar_one()
    assert row.visibility_status == "visible" and row.missing_streak == 0


def test_rating_only_run_saves_snapshot_without_reviews(db_session, target):
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="partial",
                        rating=RatingCapture(average_rating=2.6, rating_count=7))
    db_session.flush()
    assert len(db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all()) == 1
    assert db_session.execute(select(AmazonReviewReview)).scalars().all() == []


def test_failed_run_writes_run_only_and_unknown_target_rejected(db_session, target):
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="failed",
                        error_message="timeout")
    db_session.flush()
    assert db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all() == []
    run = db_session.execute(select(AmazonReviewCrawlRun)).scalar_one()
    assert run.status == "failed" and run.ratings_captured is False
    with pytest.raises(IngestionError, match="target not found"):
        record_crawl_result(db_session, target_id=999999999, captured_at=_now(), status="failed")

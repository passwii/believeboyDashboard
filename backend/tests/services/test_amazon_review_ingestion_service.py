from __future__ import annotations

import importlib
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import delete, select

from app.db.session import SessionLocal
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

# 直接 import 该新模块会被本地 LSP 的陈旧索引误报；动态导入拿到真实模块对象，
# 既能 monkeypatch 内部查找函数，又与 tests/api/test_amazon_review_external.py 一致。
service = importlib.import_module("app.services.amazon_review_ingestion_service")


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


def _rating(**kw: Any) -> RatingCapture:
    return RatingCapture(**kw)


def _capture(**kw: Any) -> ReviewCapture:
    return ReviewCapture(**kw)


def _commit_seed(*, run_key: str | None = None, snapshot_date: date | None = None) -> dict:
    """独立 session 提交一条既有外部目标（可选含一条已提交 run / 同日快照）。

    模拟「并发下另一方已先提交」的状态，供 savepoint 恢复测试复用。
    """
    db = SessionLocal()
    try:
        target = AmazonReviewTarget(
            kind="external_asin", marketplace="US",
            asin=f"B0{uuid.uuid4().hex[:8].upper()}", display_name="seed", is_active=True)
        db.add(target)
        db.flush()
        if run_key is not None:
            db.add(AmazonReviewCrawlRun(
                target_id=target.id, idempotency_key=run_key, started_at=datetime.now(timezone.utc),
                finished_at=datetime.now(timezone.utc), status="success",
                is_complete_list=False, ratings_captured=False))
            db.flush()
        if snapshot_date is not None:
            db.add(AmazonReviewRatingSnapshot(
                target_id=target.id, capture_date=snapshot_date,
                captured_at=datetime.now(timezone.utc), capture_status="success"))
            db.flush()
        db.commit()
        return {"target_id": target.id}
    finally:
        db.close()


def _cleanup_seed(seed: dict) -> None:
    db = SessionLocal()
    try:
        db.execute(delete(AmazonReviewReview).where(AmazonReviewReview.target_id == seed["target_id"]))
        db.execute(delete(AmazonReviewRatingSnapshot).where(AmazonReviewRatingSnapshot.target_id == seed["target_id"]))
        db.execute(delete(AmazonReviewCrawlRun).where(AmazonReviewCrawlRun.target_id == seed["target_id"]))
        db.execute(delete(AmazonReviewTarget).where(AmazonReviewTarget.id == seed["target_id"]))
        db.commit()
    finally:
        db.close()


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
    kw: dict[str, Any] = {
        "target_id": target.id, "captured_at": _now(), "status": "success",
        "rating": RatingCapture(average_rating=4.5, rating_count=10),
        "reviews": [_review("R1")], "is_complete_list": True, "idempotency_key": "k-1",
    }
    record_crawl_result(db_session, **kw)
    record_crawl_result(db_session, **kw)
    db_session.flush()
    assert len(db_session.execute(select(AmazonReviewCrawlRun)).scalars().all()) == 1
    assert len(db_session.execute(select(AmazonReviewReview)).scalars().all()) == 1


def test_empty_string_idempotency_key_is_a_valid_key_and_noops(db_session, target):
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                        reviews=[_review("R1")], idempotency_key="")
    record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                        reviews=[_review("R1")], idempotency_key="")
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


def test_failed_run_with_rating_and_reviews_writes_run_only(db_session, target):
    result = record_crawl_result(
        db_session, target_id=target.id, captured_at=_now(), status="failed",
        rating=RatingCapture(average_rating=4.5, rating_count=10),
        reviews=[_review("R1")], is_complete_list=True, error_message="timeout",
    )
    db_session.flush()
    assert db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all() == []
    assert db_session.execute(select(AmazonReviewReview)).scalars().all() == []
    run = db_session.execute(select(AmazonReviewCrawlRun)).scalar_one()
    assert run.status == "failed" and run.ratings_captured is True
    assert result.snapshot_updated is False and result.reviews_upserted == 0


def test_star_arrays_must_have_exactly_five_values(db_session, target):
    for bad in ((1, 2, 3, 4), (1, 2, 3, 4, 5, 6)):
        with pytest.raises(IngestionError, match="exactly 5"):
            record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                                rating=RatingCapture(average_rating=4.5, star_percentages=bad))
        with pytest.raises(IngestionError, match="exactly 5"):
            record_crawl_result(db_session, target_id=target.id, captured_at=_now(), status="success",
                                rating=RatingCapture(star_counts=bad))
    db_session.flush()
    assert db_session.execute(select(AmazonReviewCrawlRun)).scalars().all() == []
    assert db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all() == []


def test_naive_captured_at_rejected(db_session, target):
    with pytest.raises(IngestionError, match="timezone"):
        record_crawl_result(db_session, target_id=target.id,
                            captured_at=datetime(2026, 10, 20, 3, 0), status="success")
    assert db_session.execute(select(AmazonReviewCrawlRun)).scalars().all() == []


def test_aware_utc_crossing_business_date_boundary(db_session, target):
    result = record_crawl_result(
        db_session, target_id=target.id, captured_at=datetime(2026, 10, 20, 20, 0, tzinfo=timezone.utc),
        status="success", rating=RatingCapture(average_rating=4.5),
    )
    db_session.flush()
    assert result.capture_date == date(2026, 10, 21)
    snap = db_session.execute(select(AmazonReviewRatingSnapshot)).scalar_one()
    assert snap.capture_date == date(2026, 10, 21)


def test_duplicate_review_keys_deduped_in_count_and_rows(db_session, target):
    result = record_crawl_result(
        db_session, target_id=target.id, captured_at=_now(), status="success",
        reviews=[_review("R1", title="old"), _review("R2"), _review("R1", title="new")],
        is_complete_list=True,
    )
    db_session.flush()
    rows = db_session.execute(select(AmazonReviewReview)).scalars().all()
    assert len(rows) == 2 and result.reviews_upserted == 2
    r1 = next(row for row in rows if row.review_key == "R1")
    assert r1.title == "new"


def test_invalid_enums_and_ranges_rejected(db_session, target):
    cases: list[dict[str, Any]] = [
        {"status": "weird"},
        {"status": "success", "rating": _rating(star_count_quality="maybe")},
        {"status": "success", "rating": _rating(average_rating=6)},
        {"status": "success", "rating": _rating(average_rating=-0.1)},
        {"status": "success", "rating": _rating(star_percentages=(0, 0, 0, 0, 101))},
        {"status": "success", "rating": _rating(star_percentages=(0, 0, 0, 0, -1))},
        {"status": "success", "rating": _rating(star_counts=(1, 2, 3, 4, -1))},
        {"status": "success", "rating": _rating(rating_count=-1)},
        {"status": "success", "rating": _rating(review_count=-1)},
        {"status": "success", "reviews": [_capture(review_key="R1", id_confidence="bogus")]},
        {"status": "success", "reviews": [_capture(review_key="R1", id_confidence="original", rating=0)]},
        {"status": "success", "reviews": [_capture(review_key="R1", id_confidence="original", rating=6)]},
        {"status": "success", "reviews": [_review("R1", helpful_count=-1)]},
    ]
    for case in cases:
        with pytest.raises(IngestionError):
            record_crawl_result(db_session, target_id=target.id, captured_at=_now(), **case)
    db_session.flush()
    assert db_session.execute(select(AmazonReviewCrawlRun)).scalars().all() == []
    assert db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all() == []
    assert db_session.execute(select(AmazonReviewReview)).scalars().all() == []


def test_same_idempotency_key_concurrent_conflict_recovers(monkeypatch, db_session):
    """savepoint 恢复：相同 idempotency_key 并发插入撞唯一约束 → 幂等 noop，仅 1 条 run。"""
    seed = _commit_seed(run_key="k-concurrent")
    try:
        real_existing = service._existing_run
        calls = {"n": 0}

        def first_miss(db, target_id, idempotency_key):
            calls["n"] += 1
            if calls["n"] == 1:
                return None  # 模拟并发：另一 session 已提交，但本次首个 select 查不到
            return real_existing(db, target_id, idempotency_key)

        monkeypatch.setattr(service, "_existing_run", first_miss)

        result = record_crawl_result(
            db_session, target_id=seed["target_id"], captured_at=_now(), status="success",
            rating=RatingCapture(average_rating=4.5), idempotency_key="k-concurrent")
        db_session.flush()

        assert result.snapshot_updated is False and result.reviews_upserted == 0
        assert calls["n"] >= 2
        runs = db_session.execute(select(AmazonReviewCrawlRun).where(
            AmazonReviewCrawlRun.target_id == seed["target_id"])).scalars().all()
        assert len(runs) == 1 and runs[0].idempotency_key == "k-concurrent"
    finally:
        db_session.rollback()
        _cleanup_seed(seed)


def test_same_day_snapshot_concurrent_conflict_recovers(monkeypatch, db_session):
    """savepoint 恢复：同 (target_id, capture_date) 快照并发插入撞唯一约束，仅 1 条且内容为本次。"""
    seed = _commit_seed(snapshot_date=date(2026, 10, 20))
    try:
        real_find = service._find_snapshot
        calls = {"n": 0}

        def first_miss(db, target_id, capture_date):
            calls["n"] += 1
            if calls["n"] == 1:
                return None
            return real_find(db, target_id, capture_date)

        monkeypatch.setattr(service, "_find_snapshot", first_miss)

        result = record_crawl_result(
            db_session, target_id=seed["target_id"], captured_at=_now(), status="success",
            rating=RatingCapture(average_rating=4.6, rating_count=11))
        db_session.flush()

        assert result.snapshot_updated is True
        assert calls["n"] >= 2
        snaps = db_session.execute(select(AmazonReviewRatingSnapshot).where(
            AmazonReviewRatingSnapshot.target_id == seed["target_id"])).scalars().all()
        assert len(snaps) == 1 and float(snaps[0].average_rating) == 4.6
    finally:
        db_session.rollback()
        _cleanup_seed(seed)


def test_non_finite_numbers_rejected(db_session, target):
    cases: list[dict[str, Any]] = [
        {"status": "success", "rating": _rating(average_rating=float("nan"))},
        {"status": "success", "rating": _rating(average_rating=float("inf"))},
        {"status": "success", "rating": _rating(star_percentages=(0, 0, 0, 0, float("nan")))},
        {"status": "success", "rating": _rating(star_percentages=(0, 0, 0, 0, float("inf")))},
        {"status": "success", "rating": _rating(star_counts=(1, 2, 3, 4, float("inf")))},
        {"status": "success", "rating": _rating(star_counts=(1, 2, 3, 4, float("nan")))},
    ]
    for case in cases:
        with pytest.raises(IngestionError):
            record_crawl_result(db_session, target_id=target.id, captured_at=_now(), **case)
    db_session.flush()
    assert db_session.execute(select(AmazonReviewCrawlRun)).scalars().all() == []
    assert db_session.execute(select(AmazonReviewRatingSnapshot)).scalars().all() == []
    assert db_session.execute(select(AmazonReviewReview)).scalars().all() == []

# 阶段 B2：采集结果写入服务

> 父计划：[阶段 B 总览](./2026-10-16-amazon-review-tracking-phase-b.md) · 设计：[B 规格](../../specs/2026-10-16-amazon-review-tracking-phase-b-design.md) §3、§4
> 依赖：B1（新表就绪）。

**Files（本册涉及）：**
- Create: `backend/app/services/amazon_review_ingestion_service.py`
- Test: `backend/tests/services/test_amazon_review_ingestion_service.py`（新建）

---

## Task 3：`record_crawl_result`

- [ ] **步骤 1：写失败测试**

创建 `backend/tests/services/test_amazon_review_ingestion_service.py`：

```python
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
```

- [ ] **步骤 2：运行确认失败**

运行：`cd backend && pytest tests/services/test_amazon_review_ingestion_service.py -q`
预期：FAIL——`ModuleNotFoundError: No module named 'app.services.amazon_review_ingestion_service'`。

- [ ] **步骤 3：实现服务**

创建 `backend/app/services/amazon_review_ingestion_service.py`（完整文件）：

```python
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
    if not idempotency_key:
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
    if rating is not None:
        _upsert_snapshot(db, target_id, effective_date, captured_at, rating, status, source)
        snapshot_updated = True

    upserted = 0
    suspects = 0
    if reviews is not None:
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
```

- [ ] **步骤 4：运行确认通过**

运行：`cd backend && pytest tests/services/test_amazon_review_ingestion_service.py -q`
预期：全部 PASS。

- [ ] **步骤 5：commit**

```bash
git add backend/app/services/amazon_review_ingestion_service.py backend/tests/services/test_amazon_review_ingestion_service.py
git commit -m "feat(评论追踪): 实现采集结果写入服务"
```

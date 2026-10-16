from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Project, SkuRecord
from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewExternalLink,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewTarget,
)
from app.services.amazon_review_tracking_service import create_group


@pytest.fixture
def internal_target(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    sku = SkuRecord(
        project_id=project.id, project_name=project.project_name,
        sku=f"target-model-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=910000, is_active=True,
    )
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US", name=f"G-{uuid.uuid4().hex[:6]}",
        member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    target = AmazonReviewTarget(kind="internal_group", group_id=group.id, project_id=project.id,
                                marketplace="US", asin=sku.asin, is_active=True)
    db_session.add(target)
    db_session.flush()
    return target


def test_internal_target_shape_and_unique_group(db_session, internal_target):
    assert internal_target.kind == "internal_group"
    assert internal_target.group_id is not None and internal_target.project_id is not None
    assert internal_target.marketplace == "US" and internal_target.asin is not None
    other = AmazonReviewTarget(
        kind="internal_group", group_id=internal_target.group_id,
        project_id=internal_target.project_id, marketplace="US", asin="B0DUP",
    )
    db_session.add(other)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_external_target_requires_asin_and_unique_marketplace_asin(db_session):
    t1 = AmazonReviewTarget(kind="external_asin", marketplace="US", asin="B0EXT00001", is_active=True)
    db_session.add(t1)
    db_session.flush()
    dup = AmazonReviewTarget(kind="external_asin", marketplace="US", asin="B0EXT00001", is_active=True)
    db_session.add(dup)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_snapshot_unique_per_target_and_capture_date(db_session, internal_target):
    from datetime import date, datetime, timezone

    snap = AmazonReviewRatingSnapshot(
        target_id=internal_target.id, capture_date=date(2026, 10, 16),
        captured_at=datetime.now(timezone.utc), average_rating=2.6, rating_count=7,
        capture_status="success", star_count_quality="estimated",
    )
    db_session.add(snap)
    db_session.flush()
    dup = AmazonReviewRatingSnapshot(
        target_id=internal_target.id, capture_date=date(2026, 10, 16),
        captured_at=datetime.now(timezone.utc), capture_status="partial",
    )
    db_session.add(dup)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_review_and_run_and_link_uniqueness(db_session, internal_target):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    db_session.add(AmazonReviewReview(
        target_id=internal_target.id, review_key="R1", id_confidence="original",
        first_seen_at=now, last_seen_at=now,
    ))
    db_session.flush()
    db_session.add(AmazonReviewReview(
        target_id=internal_target.id, review_key="R1", id_confidence="original",
        first_seen_at=now, last_seen_at=now,
    ))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()

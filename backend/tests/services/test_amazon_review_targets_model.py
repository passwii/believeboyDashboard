from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models import Project, ProjectShop, SkuRecord
from app.models.amazon_review_tracking import (
    AmazonReviewCrawlRun,
    AmazonReviewExternalLink,
    AmazonReviewRatingSnapshot,
    AmazonReviewReview,
    AmazonReviewTarget,
)
from app.services.amazon_review_tracking_service import create_group


def _add_sku(db_session, project: Project) -> SkuRecord:
    sku = SkuRecord(
        project_id=project.id, project_name=project.project_name,
        sku=f"target-model-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=910000, is_active=True,
    )
    db_session.add(sku)
    db_session.flush()
    return sku


@pytest.fixture
def active_project(db_session) -> Project:
    return db_session.execute(
        select(Project).where(Project.is_active.is_(True)).order_by(Project.id).limit(1)
    ).scalar_one()


@pytest.fixture
def scoped_group(db_session, active_project):
    """A phase-A group (project/US) with one member; returns (project, sku, group)."""
    sku = _add_sku(db_session, active_project)
    group = create_group(db_session, project_id=active_project.id, marketplace="US",
        name=f"G-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    return active_project, sku, group


@pytest.fixture
def internal_target(db_session, scoped_group):
    project, sku, group = scoped_group
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


def test_review_unique_per_target_and_review_key(db_session, internal_target):
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


def test_crawl_run_unique_per_target_and_idempotency_key(db_session, internal_target):
    now = datetime.now(timezone.utc)
    db_session.add(AmazonReviewCrawlRun(
        target_id=internal_target.id, idempotency_key="idem-1", started_at=now, status="success",
    ))
    db_session.flush()
    db_session.add(AmazonReviewCrawlRun(
        target_id=internal_target.id, idempotency_key="idem-1", started_at=now, status="success",
    ))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_external_link_unique_per_target_and_shop(db_session):
    shop = db_session.execute(select(ProjectShop).limit(1)).scalar_one_or_none()
    if shop is None:
        project = db_session.execute(
            select(Project).where(Project.is_active.is_(True)).order_by(Project.id).limit(1)
        ).scalar_one()
        shop = ProjectShop(
            project_id=project.id, country="US", shop_id=f"test-shop-{uuid.uuid4().hex[:10]}",
        )
        db_session.add(shop)
        db_session.flush()
    target = AmazonReviewTarget(
        kind="external_asin", marketplace="US",
        asin=f"B0{uuid.uuid4().hex[:8].upper()}", is_active=True,
    )
    db_session.add(target)
    db_session.flush()
    db_session.add(AmazonReviewExternalLink(target_id=target.id, shop_id=shop.id, is_active=True))
    db_session.flush()
    db_session.add(AmazonReviewExternalLink(target_id=target.id, shop_id=shop.id, is_active=True))
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_target_kind_check_rejects_unknown_kind(db_session, active_project):
    bad = AmazonReviewTarget(
        kind="bogus", group_id=None, project_id=active_project.id, marketplace="US", is_active=True,
    )
    db_session.add(bad)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_external_target_shape_check_rejects_missing_asin(db_session):
    bad = AmazonReviewTarget(kind="external_asin", marketplace="US", asin=None, is_active=True)
    db_session.add(bad)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_internal_target_shape_check_rejects_missing_group(db_session, active_project):
    bad = AmazonReviewTarget(
        kind="internal_group", group_id=None, project_id=active_project.id,
        marketplace="US", asin="B0NOGRP01", is_active=True,
    )
    db_session.add(bad)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_internal_target_rejects_group_from_other_project(db_session):
    """Composite FK (group_id, project_id, marketplace) blocks cross-project attribution."""
    projects = db_session.execute(
        select(Project).where(Project.is_active.is_(True)).order_by(Project.id).limit(2)
    ).scalars().all()
    assert len(projects) == 2, "test DB needs at least two active projects"
    owner, other = projects
    sku = _add_sku(db_session, other)
    group = create_group(db_session, project_id=other.id, marketplace="US",
        name=f"G-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    bad = AmazonReviewTarget(
        kind="internal_group", group_id=group.id, project_id=owner.id,
        marketplace="US", asin=sku.asin, is_active=True,
    )
    db_session.add(bad)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()


def test_internal_target_rejects_wrong_marketplace(db_session, scoped_group):
    """Composite FK (group_id, project_id, marketplace) blocks wrong-marketplace attribution."""
    project, _sku, group = scoped_group
    bad = AmazonReviewTarget(
        kind="internal_group", group_id=group.id, project_id=project.id,
        marketplace="DE", asin=None, is_active=True,
    )
    db_session.add(bad)
    with pytest.raises(IntegrityError):
        db_session.flush()
    db_session.rollback()

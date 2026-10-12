from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Project, SkuRecord
from app.services.amazon_review_tracking_service import (
    ReviewGroupError, create_group, deactivate_group, replace_group_members, set_representative,
)


@pytest.fixture
def data(db_session: Session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    records = []
    for idx, marketplace in enumerate(("US", "US", "UK")):
        record = SkuRecord(project_id=project.id, project_name=project.project_name,
            sku=f"review-test-{uuid.uuid4().hex[:8]}-{idx}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
            country=marketplace, fob_unit_cost=0, sort_order=900000 + idx, is_active=True)
        db_session.add(record)
        records.append(record)
    db_session.flush()
    yield project, records
    db_session.rollback()


def test_create_group_success_and_representative_must_be_member(db_session, data):
    project, (one, two, _) = data
    group = create_group(db_session, project_id=project.id, marketplace="US", name=" Shared ", member_ids=[one.id], representative_id=one.id)
    db_session.flush()
    assert group.name == "Shared" and group.representative_sku_record_id == one.id
    with pytest.raises(ReviewGroupError, match="representative"):
        create_group(db_session, project_id=project.id, marketplace="US", name="Bad", member_ids=[one.id], representative_id=two.id)


def test_reject_cross_marketplace_and_duplicate_members(db_session, data):
    project, (one, _, ca) = data
    with pytest.raises(ReviewGroupError):
        create_group(db_session, project_id=project.id, marketplace="US", name="cross", member_ids=[one.id, ca.id], representative_id=one.id)
    with pytest.raises(ReviewGroupError, match="duplicate"):
        create_group(db_session, project_id=project.id, marketplace="US", name="dup", member_ids=[one.id, one.id], representative_id=one.id)


def test_replace_members_and_representative_keep_group_and_soft_remove(db_session, data):
    project, (one, two, _) = data
    group = create_group(db_session, project_id=project.id, marketplace="US", name="Group", member_ids=[one.id, two.id], representative_id=one.id)
    db_session.flush()
    stable_id = group.id
    from app.models.amazon_review_tracking import AmazonReviewGroupMember
    old_member = db_session.execute(select(AmazonReviewGroupMember).where(AmazonReviewGroupMember.group_id == group.id, AmazonReviewGroupMember.sku_record_id == one.id)).scalar_one()
    set_representative(db_session, group_id=group.id, sku_record_id=two.id)
    replace_group_members(db_session, group_id=group.id, member_ids=[two.id])
    db_session.flush()
    assert group.id == stable_id and old_member.removed_at is not None
    assert group.representative_sku_record_id == two.id


def test_reject_cross_project_same_marketplace(db_session, data):
    from app.models import Project

    project, (one, _, _) = data
    other_project = Project(project_name=f"review-other-{uuid.uuid4().hex[:8]}", sort_order=900020, is_active=True)
    db_session.add(other_project)
    db_session.flush()
    foreign = SkuRecord(project_id=other_project.id, project_name=other_project.project_name,
        sku=f"review-foreign-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=900010, is_active=True)
    db_session.add(foreign)
    db_session.flush()
    with pytest.raises(ReviewGroupError, match="same Project and Marketplace"):
        create_group(db_session, project_id=project.id, marketplace="US", name="cross-project",
            member_ids=[one.id, foreign.id], representative_id=one.id)


def test_representative_switch_and_original_representative_cannot_be_removed(db_session, data):
    project, (one, two, _) = data
    group = create_group(db_session, project_id=project.id, marketplace="US", name="Switch",
        member_ids=[one.id, two.id], representative_id=one.id)
    set_representative(db_session, group_id=group.id, sku_record_id=two.id)
    with pytest.raises(ReviewGroupError, match="representative"):
        replace_group_members(db_session, group_id=group.id, member_ids=[one.id])
    replace_group_members(db_session, group_id=group.id, member_ids=[two.id])
    db_session.flush()
    assert group.representative_sku_record_id == two.id
    assert group.id is not None
    from app.models.amazon_review_tracking import AmazonReviewGroupMember
    removed = db_session.execute(select(AmazonReviewGroupMember).where(
        AmazonReviewGroupMember.group_id == group.id, AmazonReviewGroupMember.sku_record_id == one.id
    )).scalar_one()
    assert removed.removed_at is not None


def test_replace_integrity_error_leaves_session_recoverable(db_session, data):
    project, (one, two, _) = data
    group_a = create_group(db_session, project_id=project.id, marketplace="US", name="A",
        member_ids=[one.id], representative_id=one.id)
    group_b = create_group(db_session, project_id=project.id, marketplace="US", name="B",
        member_ids=[two.id], representative_id=two.id)
    with pytest.raises(ReviewGroupError, match="already belongs"):
        replace_group_members(db_session, group_id=group_b.id, member_ids=[one.id, two.id])
    assert db_session.is_active
    assert db_session.get(type(group_a), group_a.id) is not None


def test_marketplace_schema_normalizes_and_rejects_invalid():
    from pydantic import ValidationError
    from app.schemas.amazon_review_tracking import ReviewGroupCreate

    payload = dict(project_id=1, marketplace=" us ", name=" Group ", member_ids=[1], representative_id=1)
    assert ReviewGroupCreate(**payload).marketplace == "US"
    with pytest.raises(ValidationError):
        ReviewGroupCreate(**{**payload, "marketplace": "ZZ"})


def test_duplicate_group_unknown_sku_inactive_group_and_invalid_marketplace(db_session, data):
    project, (one, _, _) = data
    group = create_group(db_session, project_id=project.id, marketplace="US", name="Unique", member_ids=[one.id], representative_id=one.id)
    db_session.flush()
    with pytest.raises(ReviewGroupError, match="already"):
        create_group(db_session, project_id=project.id, marketplace="US", name="Unique", member_ids=[one.id], representative_id=one.id)
    with pytest.raises(ReviewGroupError, match="SKU"):
        create_group(db_session, project_id=project.id, marketplace="US", name="Unknown", member_ids=[999999999], representative_id=999999999)
    deactivate_group(db_session, group_id=group.id)
    with pytest.raises(ReviewGroupError, match="inactive"):
        replace_group_members(db_session, group_id=group.id, member_ids=[one.id])
    with pytest.raises(ReviewGroupError, match="Marketplace"):
        create_group(db_session, project_id=project.id, marketplace="ZZ", name="Invalid", member_ids=[one.id], representative_id=one.id)

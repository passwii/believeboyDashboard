from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import get_primary_db_session, get_read_db_session
from app.api.v1.endpoints import amazon_review_tracking as endpoint
from app.models import Project, SkuRecord
from app.models.amazon_review_tracking import AmazonReviewTarget
from app.services.amazon_review_ingestion_service import (
    RatingCapture,
    ReviewCapture,
    record_crawl_result,
)
from app.services.amazon_review_tracking_service import create_group
from app.services.project_service import invalidate_projects_cache

TARGETS_URL = "/api/v1/amazon-review-tracking/targets"


@pytest.fixture
def admin_headers(admin_headers):
    """Root-conftest auth headers + an internal session id.

    ``_require_session`` demands a validated internal session; the root fixture
    only carries ``X-User-Id`` (the legacy admin-only path used ``X-Is-Admin``).
    """
    return {**admin_headers, "X-Session-Id": "ops-test-session"}


@pytest.fixture
def operator_headers(operator_headers):
    return {**operator_headers, "X-Session-Id": "ops-test-session"}


@pytest.fixture
def businessdev_headers(businessdev_headers):
    return {**businessdev_headers, "X-Session-Id": "ops-test-session"}


@pytest.fixture
def client(db_session, monkeypatch):
    """TestClient over the review-tracking router with a shared test session."""
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: True)
    app = FastAPI()
    app.include_router(endpoint.router, prefix="/api/v1")
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.dependency_overrides[get_read_db_session] = lambda: db_session
    return TestClient(app, raise_server_exceptions=False)


def _seed_target(db_session):
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    sku = SkuRecord(project_id=project.id, project_name=project.project_name,
        sku=f"ops-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=930000, is_active=True)
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US",
        name=f"Ops-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    target = db_session.execute(select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)).scalar_one()
    record_crawl_result(db_session, target_id=target.id, captured_at=datetime(2026, 10, 21, tzinfo=timezone.utc),
        status="success", rating=RatingCapture(average_rating=4.1, rating_count=9),
        reviews=[ReviewCapture(review_key="R1", id_confidence="original", rating=4, title="t")],
        is_complete_list=True)
    db_session.flush()
    return target


def _seed_project_targets(db_session, count):
    """One dedicated project with ``count`` internal-group targets (isolated for pagination)."""
    project = Project(project_name=f"ops-page-{uuid.uuid4().hex[:8]}", sort_order=930100, is_active=True)
    db_session.add(project)
    db_session.flush()
    targets = []
    for _ in range(count):
        sku = SkuRecord(
            project_id=project.id, project_name=project.project_name,
            sku=f"ops-page-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
            country="US", fob_unit_cost=0, sort_order=930100, is_active=True,
        )
        db_session.add(sku)
        db_session.flush()
        group = create_group(db_session, project_id=project.id, marketplace="US",
            name=f"OpsPage-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
        db_session.flush()
        targets.append(db_session.execute(
            select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
        ).scalar_one())
    db_session.flush()
    return project.id, targets


def test_list_targets_filters_by_group_and_kind(client, admin_headers, db_session):
    # 专属 project 隔离：共享 BLF_test 累积内部目标已 >默认 limit(200)，
    # 不得断言未按项目过滤的全局首屏包含新目标。
    project_id, target = _seed_scoped_target(db_session)
    resp = client.get(TARGETS_URL, params={"project_id": project_id, "kind": "internal_group"},
                      headers=admin_headers)
    assert resp.status_code == 200
    assert {item["id"] for item in resp.json()} == {target.id}


def test_rating_snapshots_and_reviews_and_runs(client, admin_headers, db_session):
    target = _seed_target(db_session)
    snaps = client.get(f"{TARGETS_URL}/{target.id}/rating-snapshots",
                       params={"from": "2026-10-01", "to": "2026-10-31"}, headers=admin_headers)
    assert snaps.status_code == 200 and len(snaps.json()) == 1
    assert snaps.json()[0]["average_rating"] == 4.1

    reviews = client.get(f"{TARGETS_URL}/{target.id}/reviews", headers=admin_headers)
    assert reviews.status_code == 200 and reviews.json()[0]["review_key"] == "R1"

    runs = client.get(f"{TARGETS_URL}/{target.id}/runs", headers=admin_headers)
    assert runs.status_code == 200 and runs.json()[0]["status"] == "success"


def test_unknown_target_returns_404_and_requires_session(client, admin_headers):
    assert client.get(f"{TARGETS_URL}/999999999/reviews", headers=admin_headers).status_code == 404
    assert client.get(TARGETS_URL).status_code == 401


def test_revoked_session_returns_401(client, admin_headers, monkeypatch):
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: False)
    assert client.get(TARGETS_URL, headers=admin_headers).status_code == 401


def test_operator_session_can_read(client, operator_headers):
    assert client.get(TARGETS_URL, headers=operator_headers).status_code == 200


def test_non_operator_session_forbidden(client, businessdev_headers):
    resp = client.get(TARGETS_URL, headers=businessdev_headers)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "需要运营或管理员权限"


def test_target_filters_exclude_non_matching(client, admin_headers, db_session):
    # 专属 project（US）隔离断言，不依赖全局列表规模。
    project_id, internal = _seed_scoped_target(db_session)
    external = _seed_external_target(db_session)  # external_asin，无 project

    kind_match = client.get(TARGETS_URL, params={"project_id": project_id, "kind": "internal_group"},
                            headers=admin_headers).json()
    assert {item["id"] for item in kind_match} == {internal.id}

    # kind 不匹配（external）在该 project 范围内为空；external 目标（无 project）被排除
    kind_mismatch = client.get(TARGETS_URL, params={"project_id": project_id, "kind": "external_asin"},
                               headers=admin_headers).json()
    assert kind_mismatch == []
    assert external.id not in {item["id"] for item in kind_mismatch}

    # marketplace 不匹配：专属 project 为 US，按 UK 过滤为空；按 US 过滤命中原目标
    assert client.get(TARGETS_URL, params={"project_id": project_id, "marketplace": "UK"},
                      headers=admin_headers).json() == []
    market_match = client.get(TARGETS_URL, params={"project_id": project_id, "marketplace": "US"},
                              headers=admin_headers).json()
    assert {item["id"] for item in market_match} == {internal.id}


def test_reviews_and_runs_pagination_and_limit_bounds(client, admin_headers, db_session):
    target = _seed_target(db_session)
    record_crawl_result(db_session, target_id=target.id, captured_at=datetime(2026, 10, 22, tzinfo=timezone.utc),
        status="success", reviews=[
            ReviewCapture(review_key="R2", id_confidence="original", rating=5),
            ReviewCapture(review_key="R3", id_confidence="original", rating=3),
        ])
    db_session.flush()

    reviews_url = f"{TARGETS_URL}/{target.id}/reviews"
    first = client.get(reviews_url, params={"limit": 2, "offset": 0}, headers=admin_headers)
    assert first.status_code == 200 and [r["review_key"] for r in first.json()] == ["R1", "R2"]
    second = client.get(reviews_url, params={"limit": 2, "offset": 2}, headers=admin_headers)
    assert second.status_code == 200 and [r["review_key"] for r in second.json()] == ["R3"]
    assert client.get(reviews_url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(reviews_url, params={"limit": 501}, headers=admin_headers).status_code == 422

    runs_url = f"{TARGETS_URL}/{target.id}/runs"
    first_run = client.get(runs_url, params={"limit": 1, "offset": 0}, headers=admin_headers)
    assert first_run.status_code == 200 and len(first_run.json()) == 1
    assert client.get(runs_url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(runs_url, params={"limit": 201}, headers=admin_headers).status_code == 422


def test_targets_and_snapshots_limit_bounds(client, admin_headers, db_session):
    target = _seed_target(db_session)
    assert client.get(TARGETS_URL, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(TARGETS_URL, params={"limit": 1001}, headers=admin_headers).status_code == 422
    snaps_url = f"{TARGETS_URL}/{target.id}/rating-snapshots"
    assert client.get(snaps_url, params={"limit": 0}, headers=admin_headers).status_code == 422
    assert client.get(snaps_url, params={"limit": 1001}, headers=admin_headers).status_code == 422


def test_targets_pagination_orders_by_id_and_covers_all(client, admin_headers, db_session):
    project_id, targets = _seed_project_targets(db_session, 3)
    page1 = client.get(TARGETS_URL, params={"project_id": project_id, "limit": 2, "offset": 0},
                       headers=admin_headers)
    page2 = client.get(TARGETS_URL, params={"project_id": project_id, "limit": 2, "offset": 2},
                       headers=admin_headers)
    assert page1.status_code == 200 and page2.status_code == 200
    ids = [item["id"] for item in page1.json()] + [item["id"] for item in page2.json()]
    assert len(page1.json()) == 2 and len(page2.json()) == 1
    # 两页并集 == 全集，且为 id 升序 → 不重不漏、确定顺序
    assert ids == sorted(t.id for t in targets)


def test_rating_snapshots_pagination_orders_by_date_and_covers_all(client, admin_headers, db_session):
    target = _seed_target(db_session)  # 快照 capture_date = 2026-10-21
    for day in (22, 23):
        record_crawl_result(db_session, target_id=target.id,
            captured_at=datetime(2026, 10, day, tzinfo=timezone.utc),
            status="success", rating=RatingCapture(average_rating=4.0))
    db_session.flush()
    url = f"{TARGETS_URL}/{target.id}/rating-snapshots"

    full = client.get(url, headers=admin_headers).json()
    assert [s["capture_date"] for s in full] == ["2026-10-21", "2026-10-22", "2026-10-23"]

    page1 = client.get(url, params={"limit": 2, "offset": 0}, headers=admin_headers).json()
    page2 = client.get(url, params={"limit": 2, "offset": 2}, headers=admin_headers).json()
    assert len(page1) == 2 and len(page2) == 1
    dates = [s["capture_date"] for s in page1] + [s["capture_date"] for s in page2]
    assert dates == [s["capture_date"] for s in full] and len(set(dates)) == 3

    # (target_id, capture_date) 有 DB 唯一约束，同一目标同日期不可能出现两条，
    # 故无法构造 id 次级键并列；改以重复请求断言顺序确定（deterministic）。
    repeat = client.get(url, params={"limit": 2, "offset": 0}, headers=admin_headers).json()
    assert repeat == page1


def _seed_scoped_target(db_session, *, project_operator=None):
    """专属 project（可指定 project_operator）下的一个内部目标，用于项目级读授权。"""
    project = Project(project_name=f"ops-scope-{uuid.uuid4().hex[:8]}", sort_order=930400,
                      is_active=True, project_operator=project_operator)
    db_session.add(project)
    db_session.flush()
    sku = SkuRecord(
        project_id=project.id, project_name=project.project_name,
        sku=f"ops-scope-{uuid.uuid4().hex[:8]}", asin=f"B0{uuid.uuid4().hex[:8].upper()}",
        country="US", fob_unit_cost=0, sort_order=930400, is_active=True,
    )
    db_session.add(sku)
    db_session.flush()
    group = create_group(db_session, project_id=project.id, marketplace="US",
        name=f"OpsScope-{uuid.uuid4().hex[:6]}", member_ids=[sku.id], representative_id=sku.id)
    db_session.flush()
    target = db_session.execute(
        select(AmazonReviewTarget).where(AmazonReviewTarget.group_id == group.id)
    ).scalar_one()
    db_session.flush()
    invalidate_projects_cache()
    return project.id, target


def _seed_external_target(db_session):
    target = AmazonReviewTarget(kind="external_asin", marketplace="US",
        asin=f"B0{uuid.uuid4().hex[:8].upper()}", is_active=True)
    db_session.add(target)
    db_session.flush()
    return target


def test_operator_reads_only_accessible_project_targets(client, operator_headers, test_operator, db_session):
    pid_ok, ok_target = _seed_scoped_target(db_session, project_operator=test_operator["name"])
    pid_no, no_target = _seed_scoped_target(db_session, project_operator="别的运营")

    ok_list = client.get(TARGETS_URL, params={"project_id": pid_ok, "limit": 1000}, headers=operator_headers)
    assert ok_list.status_code == 200
    assert ok_target.id in {item["id"] for item in ok_list.json()}

    no_list = client.get(TARGETS_URL, params={"project_id": pid_no, "limit": 1000}, headers=operator_headers)
    assert no_list.status_code == 200 and no_list.json() == []

    assert client.get(f"{TARGETS_URL}/{ok_target.id}/reviews", headers=operator_headers).status_code == 200
    for sub in ("reviews", "rating-snapshots", "runs"):
        assert client.get(f"{TARGETS_URL}/{no_target.id}/{sub}", headers=operator_headers).status_code == 404


def test_operator_without_matching_project_fails_closed_but_reads_external(client, operator_headers, db_session):
    _, internal = _seed_scoped_target(db_session, project_operator="别的运营")
    external = _seed_external_target(db_session)
    headers = {**operator_headers, "X-Operator": base64.b64encode(b"no-such-operator").decode("ascii")}

    internal_list = client.get(TARGETS_URL, params={"kind": "internal_group"}, headers=headers)
    assert internal_list.status_code == 200 and internal_list.json() == []

    # external 目标（无 project）仍可见；不做全局列表成员断言（累积数据下首屏不稳定），
    # 以 filter 语义 + 子资源可达作为判据。
    external_list = client.get(TARGETS_URL, params={"kind": "external_asin"}, headers=headers)
    assert external_list.status_code == 200
    assert all(item["kind"] == "external_asin" for item in external_list.json())

    assert client.get(f"{TARGETS_URL}/{internal.id}/reviews", headers=headers).status_code == 404
    assert client.get(f"{TARGETS_URL}/{external.id}/reviews", headers=headers).status_code == 200


def test_admin_reads_all_project_targets(client, admin_headers, test_operator, db_session):
    pid_a, target_a = _seed_scoped_target(db_session, project_operator=test_operator["name"])
    pid_b, target_b = _seed_scoped_target(db_session, project_operator="别的运营")
    for pid, target in ((pid_a, target_a), (pid_b, target_b)):
        listed = client.get(TARGETS_URL, params={"project_id": pid}, headers=admin_headers)
        assert listed.status_code == 200
        assert target.id in {item["id"] for item in listed.json()}

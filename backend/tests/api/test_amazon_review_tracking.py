import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import event, select

from app.api.deps import get_primary_db_session, get_read_db_session
from app.api.v1.endpoints import amazon_review_tracking as endpoint
from app.api.v1.endpoints.amazon_review_tracking import ReviewGroupPatch, router
from app.models.amazon_review_tracking import AmazonReviewGroup, AmazonReviewGroupMember
from app.schemas.amazon_review_tracking import ReviewGroupCreate
from app.services.amazon_review_tracking_service import create_group


@pytest.fixture
def client(db_session):
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.dependency_overrides[get_read_db_session] = lambda: db_session
    app.dependency_overrides[endpoint._require_admin] = lambda: True
    app.dependency_overrides[endpoint.require_api_key] = lambda: None
    return TestClient(app)


def test_review_group_routes_are_mounted_in_openapi(client):
    paths = client.get("/openapi.json").json()["paths"]
    groups = paths["/api/v1/amazon-review-tracking/groups"]
    assert "get" in groups and "post" in groups
    assert groups["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith("ReviewGroupCreate")
    assert "patch" in paths["/api/v1/amazon-review-tracking/groups/{group_id}"]
    assert "post" in paths["/api/v1/amazon-review-tracking/groups/{group_id}/deactivate"]


def test_x_is_admin_alone_cannot_authorize(client):
    client.app.dependency_overrides.pop(endpoint._require_admin, None)
    response = client.get("/api/v1/amazon-review-tracking/groups", headers={"X-Is-Admin": "true"})
    assert response.status_code == 401


def test_authenticated_operator_cannot_escalate_with_x_is_admin(client, monkeypatch):
    app = client.app
    app.dependency_overrides.pop(endpoint._require_admin, None)
    app.dependency_overrides[endpoint.require_api_key] = lambda: None
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: True)
    monkeypatch.setattr(endpoint, "require_api_key", lambda **kwargs: None)
    monkeypatch.setattr(endpoint, "SessionLocal", lambda: _AdminDb({"is_admin": False, "is_active": True}))
    headers = {"X-API-Key": "test-api-key", "X-User-Id": "user-id", "X-Session-Id": "valid-session", "X-Is-Admin": "true"}
    assert client.get("/api/v1/amazon-review-tracking/groups", headers=headers).status_code == 403


def test_patch_rejects_explicit_null_fields():
    for field in ("name", "member_ids", "representative_id"):
        with pytest.raises(ValidationError):
            ReviewGroupPatch.model_validate({field: None})


def test_api_rejects_cross_project_and_marketplace_members(client, db_session, monkeypatch):
    from app.models import Project, SkuRecord

    import uuid
    suffix = uuid.uuid4().hex[:8]
    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    other = Project(project_name=f"review-api-other-project-{suffix}", sort_order=999980, is_active=True)
    db_session.add(other)
    db_session.flush()
    local = SkuRecord(project_id=project.id, project_name=project.project_name, sku=f"review-api-local-{suffix}",
        asin=f"B0LOCAL{suffix.upper()}", country="US", fob_unit_cost=0, sort_order=999981, is_active=True)
    foreign = SkuRecord(project_id=other.id, project_name=other.project_name, sku=f"review-api-foreign-{suffix}",
        asin=f"B0FOREIGN{suffix.upper()}", country="US", fob_unit_cost=0, sort_order=999982, is_active=True)
    wrong_market = SkuRecord(project_id=project.id, project_name=project.project_name, sku=f"review-api-country-{suffix}",
        asin=f"B0COUNTRY{suffix.upper()}", country="UK", fob_unit_cost=0, sort_order=999983, is_active=True)
    db_session.add_all([local, foreign, wrong_market])
    db_session.flush()
    group_name = f"api-cross-check-{suffix}"
    group = create_group(db_session, project_id=project.id, marketplace="US", name=group_name,
        member_ids=[local.id], representative_id=local.id)
    db_session.commit()

    monkeypatch.setattr(endpoint, "append_operation_audit_log", lambda *args, **kwargs: None)
    # The existing client overrides auth dependencies, so these requests exercise real HTTP validation and DB deps.
    for sku_id, expected in ((foreign.id, 422), (wrong_market.id, 422)):
        response = client.patch(f"/api/v1/amazon-review-tracking/groups/{group.id}", json={"member_ids": [local.id, sku_id]})
        assert response.status_code == expected
        assert response.json()["detail"]
        db_session.expire_all()
        persisted_group = db_session.get(AmazonReviewGroup, group.id)
        assert persisted_group is not None
        assert persisted_group.name == group_name
        assert db_session.execute(select(AmazonReviewGroupMember.sku_record_id).where(
            AmazonReviewGroupMember.group_id == group.id, AmazonReviewGroupMember.removed_at.is_(None)
        )).scalars().all() == [local.id]
        assert db_session.execute(select(AmazonReviewGroup).where(AmazonReviewGroup.name == group_name)).scalars().all() == [persisted_group]


def test_group_listing_loads_members_in_one_batch(client, db_session, monkeypatch):
    client.app.dependency_overrides.pop(endpoint._require_admin, None)
    client.app.dependency_overrides[endpoint.require_api_key] = lambda: None
    from app.models import Project, SkuRecord


    project = db_session.execute(select(Project).where(Project.is_active.is_(True)).limit(1)).scalar_one()
    import uuid
    suffix = uuid.uuid4().hex[:8]
    records = []
    for idx in range(2):
        sku = SkuRecord(project_id=project.id, project_name=project.project_name,
            sku=f"review-batch-{suffix}-{idx}", asin=f"B0{suffix.upper()}{idx:01d}", country="US",
            fob_unit_cost=0, sort_order=999990 + idx, is_active=True)
        db_session.add(sku)
        records.append(sku)
    db_session.flush()
    for idx, sku in enumerate(records):
        create_group(db_session, project_id=project.id, marketplace="US", name=f"batch-{suffix}-{idx}", member_ids=[sku.id], representative_id=sku.id)
    db_session.commit()

    statements = []
    monkeypatch.setattr(endpoint, "validate_session", lambda user_id, session_id: True)
    monkeypatch.setattr(endpoint, "require_api_key", lambda **kwargs: None)
    monkeypatch.setattr(endpoint, "SessionLocal", lambda: _AdminDb({"is_admin": True, "is_active": True}))

    event.listen(db_session.bind, "before_cursor_execute", lambda *_args: statements.append(_args[2]))
    headers = {"X-API-Key": "test-api-key", "X-User-Id": "admin-id", "X-Session-Id": "valid-session"}
    response = client.get("/api/v1/amazon-review-tracking/groups", params={"project_id": project.id}, headers=headers)
    assert response.status_code == 200
    member_selects = [sql for sql in statements if "amazon_review_group_members" in sql.lower()]
    assert len(member_selects) == 1


class _AdminDb:
    def __init__(self, row):
        self.row = row

    def execute(self, *_args, **_kwargs):
        return self

    def mappings(self):
        return self

    def first(self):
        return self.row

    def close(self):
        pass

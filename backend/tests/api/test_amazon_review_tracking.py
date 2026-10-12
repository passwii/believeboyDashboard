import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.deps import get_primary_db_session, get_read_db_session
from app.api.v1.endpoints.amazon_review_tracking import router


@pytest.fixture
def client(db_session):
    app = FastAPI()
    app.include_router(router, prefix="/api/v1")
    app.dependency_overrides[get_primary_db_session] = lambda: db_session
    app.dependency_overrides[get_read_db_session] = lambda: db_session
    return TestClient(app)


def test_review_group_routes_are_mounted_in_openapi(client):
    paths = client.get("/openapi.json").json()["paths"]
    groups = paths["/api/v1/amazon-review-tracking/groups"]
    assert "get" in groups and "post" in groups
    assert groups["post"]["requestBody"]["content"]["application/json"]["schema"]["$ref"].endswith("ReviewGroupCreate")
    assert "patch" in paths["/api/v1/amazon-review-tracking/groups/{group_id}"]
    assert "post" in paths["/api/v1/amazon-review-tracking/groups/{group_id}/deactivate"]


def test_review_group_routes_require_admin(client):
    response = client.get("/api/v1/amazon-review-tracking/groups")
    assert response.status_code == 403

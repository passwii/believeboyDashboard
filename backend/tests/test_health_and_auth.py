from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_health_ok():
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_projects_requires_api_key():
    response = client.get("/api/v1/projects/manage")
    assert response.status_code == 401

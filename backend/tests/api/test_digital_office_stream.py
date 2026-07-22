from fastapi import FastAPI
from fastapi.testclient import TestClient


def _app():
    from app.api.v1.endpoints.digital_office import router
    from app.api.deps import protected

    app = FastAPI()
    app.dependency_overrides[protected] = lambda: None
    app.include_router(router, prefix="/api/v1")
    return app


def test_office_stream_is_sse(db_session):
    client = TestClient(_app())
    with client.stream("GET", "/api/v1/digital-employees/office/stream") as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        for line in resp.iter_lines():
            if line.startswith("data:"):
                assert "employees" in line
                break

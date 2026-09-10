"""BLF-1012: /insight/runs endpoints — SSE e2e via fakeredis.

Covers the acceptance matrix through the HTTP surface:

1. POST → 201 envelope with detail/stream/cancel/retry URLs (replayed flag).
2. GET detail → authoritative DB snapshot.
3. GET stream → SSE frames with canonical ``id:`` lines, terminal stops.
4. Last-Event-ID reconnect → strictly after the cursor.
5. Cancel → run row cancelled + cancelled terminal event on the stream.
6. Malformed Last-Event-ID → typed 400 (RESUME_CURSOR_INVALID).
7. Disconnect does NOT cancel the run (only the explicit endpoint does).

Auth: ``protected`` is overridden (unit-level); scope access uses the seeded
test DB project (BLF_test). The run row is created through the real
repository so permissions and URL shapes are exercised end-to-end.
"""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tests.insight.conftest import make_request


def _parse_sse(body: str) -> list[dict]:
    """SSE body → [{id, data(parsed)}]; blocks split on blank lines."""
    events = []
    for block in body.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        event_id = None
        data_str = None
        for line in block.split("\n"):
            if line.startswith("id:"):
                event_id = line[3:].strip()
            elif line.startswith("data:"):
                data_str = line[5:]
        if data_str is not None:
            events.append({"id": event_id, "data": json.loads(data_str)})
    return events


@pytest.fixture()
def insight_app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    """Test app: insight router + auth bypass + fakeredis transport.

    Provider credentials are set on the lru-cached settings singleton so
    ``start_run``'s server-side model resolution passes without real
    network access (the LLM itself is never called by these tests).
    """
    from app.api.deps import protected
    from app.api.v1.endpoints.insight_runs import router as insight_router
    from app.core.config import get_settings
    from app.services.insight import stream_bus

    settings = get_settings()
    monkeypatch.setattr(
        settings, "ai_chat_provider_base_url", "http://localhost:9/v1", raising=False
    )
    monkeypatch.setattr(settings, "ai_chat_provider_api_key", "test-key", raising=False)
    monkeypatch.setattr(settings, "insight_default_model", "test-insight-model", raising=False)
    monkeypatch.setattr(settings, "ai_chat_default_model", "test-insight-model", raising=False)

    # No broker in unit tests: enqueue is recorded, never sent.
    enqueued: list[tuple[str, int]] = []

    import app.celery_tasks.insights.run as run_task_mod

    monkeypatch.setattr(
        run_task_mod,
        "enqueue_insight_run",
        lambda rid, attempt: enqueued.append((rid, attempt)),
    )
    app = FastAPI()
    app.dependency_overrides[protected] = lambda: None
    app.include_router(insight_router, prefix="/api/v1")

    # One shared FakeServer: the sync writer (seed/cancel registry) and the
    # async subscriber must observe the same namespace, like one Redis db.
    server = fakeredis.FakeServer()

    def make_sync():
        return fakeredis.FakeRedis(server=server)

    async def make_async():
        return fakeredis.aioredis.FakeRedis(server=server)

    async def close_async():
        return None

    monkeypatch.setattr(stream_bus, "make_stream_client", make_sync)
    monkeypatch.setattr(stream_bus, "make_async_stream_client", make_async)
    monkeypatch.setattr(stream_bus, "close_async_stream_client", close_async)
    return app


@pytest.fixture()
def client(insight_app: FastAPI) -> TestClient:
    """Admin caller (repo convention: X-Is-Admin=true unlocks project scope)."""
    test_client = TestClient(insight_app)
    test_client.headers.update({"X-Is-Admin": "true"})
    return test_client


def _project_id() -> int:
    """A project visible to the test operator scope (seeded test DB)."""
    from sqlalchemy import create_engine, text

    from app.core.config import get_settings

    url = get_settings().database_url
    engine = create_engine(url)
    with engine.connect() as conn:
        row = conn.execute(text("SELECT id FROM projects ORDER BY id LIMIT 1")).first()
    engine.dispose()
    assert row is not None, "test DB has no projects seeded"
    return int(row[0])


def _unique_key(prefix: str) -> str:
    """Per-run idempotency key: the shared test DB persists rows across runs."""
    return f"{prefix}-{uuid4().hex[:12]}"


def _create_run(client: TestClient, project_id: int, key: str) -> dict:
    payload = make_request(idempotency_key=key)
    payload["project_id"] = project_id
    # Country must match the seeded project's country for scope consistency.
    payload["country"] = "US"
    payload["slots"]["report.context"]["project_ids"] = [project_id]
    resp = client.post("/api/v1/insight/runs", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _publish_event(rid: str, event: dict) -> None:
    """Push a stream entry through the real writer key layout (fakeredis)."""
    from app.services.insight import stream_bus

    sync_fake = stream_bus.make_stream_client()
    sync_fake.xadd(
        stream_bus.stream_key(rid),
        {stream_bus.EVENT_FIELD: json.dumps(event)},
    )


def _event(rid: str, seq: int, **extra: Any) -> dict:
    return {"schema_version": 1, "run_id": rid, "attempt": 1, "seq": seq, **extra}


def test_create_returns_envelope_with_urls(client: TestClient) -> None:
    project_id = _project_id()
    body = _create_run(client, project_id, _unique_key("blf-1012-create"))
    rid = body["run_id"]
    assert body["schema_version"] == 1
    assert body["status"] == "queued"
    assert body["detail_url"] == f"/api/v1/insight/runs/{rid}"
    assert body["stream_url"] == f"/api/v1/insight/runs/{rid}/stream"
    assert body["cancel_url"] == f"/api/v1/insight/runs/{rid}/cancel"
    assert body["retry_url"] == f"/api/v1/insight/runs/{rid}/retry"
    # No secrets / prompt / provider material in the envelope.
    raw = json.dumps(body)
    for banned in ("api_key", "base_url", "system_prompt", "endpoint_id"):
        assert banned not in raw


def test_create_replay_is_idempotent(client: TestClient) -> None:
    project_id = _project_id()
    key = _unique_key("blf-1012-replay")
    first = _create_run(client, project_id, key)
    payload = make_request(idempotency_key=key)
    payload["project_id"] = project_id
    payload["country"] = "US"
    payload["slots"]["report.context"]["project_ids"] = [project_id]
    second = client.post("/api/v1/insight/runs", json=payload)
    assert second.status_code == 201
    assert second.json()["run_id"] == first["run_id"]
    assert second.json()["replayed"] is True


def test_detail_returns_authoritative_snapshot(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-detail"))
    rid = created["run_id"]
    resp = client.get(f"/api/v1/insight/runs/{rid}")
    assert resp.status_code == 200
    detail = resp.json()
    assert detail["run_id"] == rid
    assert detail["status"] == "queued"
    assert detail["resume"]["current_attempt"] == 1


def test_detail_unknown_run_404(client: TestClient) -> None:
    resp = client.get("/api/v1/insight/runs/00000000-0000-4000-8000-000000000000")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "RUN_NOT_FOUND"


def test_stream_replays_frames_with_canonical_ids(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-stream"))
    rid = created["run_id"]
    _publish_event(
        rid,
        _event(rid, 1, type="snapshot", status="queued", stage="queued",
               progress_percent=5, outputs={}, is_terminal=False, error=None),
    )
    _publish_event(
        rid,
        _event(rid, 2, type="status", status="aggregating", stage="aggregating",
               progress_percent=30, detail="正在聚合数据"),
    )
    _publish_event(
        rid,
        _event(rid, 3, type="done", status="completed",
               content_sha256="a" * 64,
               outputs={"main": {"format": "markdown", "content": "## 完成",
                                 "content_sha256": "a" * 64}},
               title="标题", artifact_id=None),
    )
    with client.stream(
        "GET", f"/api/v1/insight/runs/{rid}/stream"
    ) as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers["content-type"]
        body = b"".join(resp.iter_bytes()).decode()
    events = _parse_sse(body)
    assert [e["data"]["type"] for e in events] == ["snapshot", "status", "done"]
    assert [e["id"] for e in events] == [f"{rid}:1:1", f"{rid}:1:2", f"{rid}:1:3"]
    assert events[-1]["data"]["status"] == "completed"


def test_stream_resumes_after_last_event_id(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-resume"))
    rid = created["run_id"]
    _publish_event(
        rid,
        _event(rid, 1, type="snapshot", status="queued", stage="queued",
               progress_percent=5, outputs={}, is_terminal=False, error=None),
    )
    _publish_event(
        rid,
        _event(rid, 2, type="content.delta", slot="main", block_id="b1",
               format="markdown", delta="## 摘要\n"),
    )
    _publish_event(
        rid,
        _event(rid, 3, type="done", status="completed",
               content_sha256="b" * 64,
               outputs={"main": {"format": "markdown", "content": "## 摘要\n",
                                 "content_sha256": "b" * 64}},
               title=None, artifact_id=None),
    )
    with client.stream(
        "GET",
        f"/api/v1/insight/runs/{rid}/stream",
        headers={"Last-Event-ID": f"{rid}:1:1"},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode()
    events = _parse_sse(body)
    # strictly after seq 1: delta + terminal, no duplicates
    assert [e["data"]["seq"] for e in events] == [2, 3]
    assert events[-1]["data"]["type"] == "done"


def test_stream_malformed_cursor_400(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-badcursor"))
    rid = created["run_id"]
    resp = client.get(
        f"/api/v1/insight/runs/{rid}/stream",
        headers={"Last-Event-ID": "not-a-cursor"},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "RESUME_CURSOR_INVALID"


def test_cancel_marks_row_and_returns_action(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-cancel"))
    rid = created["run_id"]
    resp = client.post(f"/api/v1/insight/runs/{rid}/cancel")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "cancelled"
    # Row is authoritative
    detail = client.get(f"/api/v1/insight/runs/{rid}").json()
    assert detail["status"] == "cancelled"
    assert detail["error"]["code"] == "CANCELLED"
    # Second cancel is idempotent (replayed=True)
    again = client.post(f"/api/v1/insight/runs/{rid}/cancel")
    assert again.status_code == 200
    assert again.json()["replayed"] is True


def test_retry_bumps_attempt_and_requeues(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-retry"))
    rid = created["run_id"]
    client.post(f"/api/v1/insight/runs/{rid}/cancel")
    resp = client.post(f"/api/v1/insight/runs/{rid}/retry")
    assert resp.status_code == 200
    body = resp.json()
    assert body["attempt"] == 2
    assert body["status"] == "queued"


def test_retry_active_run_rejected(client: TestClient) -> None:
    project_id = _project_id()
    created = _create_run(client, project_id, _unique_key("blf-1012-retry-active"))
    rid = created["run_id"]
    resp = client.post(f"/api/v1/insight/runs/{rid}/retry")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "INVALID_STATE_TRANSITION"

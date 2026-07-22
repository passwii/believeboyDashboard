"""SSE 端点测试（FIX-6）。

策略：
- _build_snapshot_sync：mock SessionLocal + build_wall_snapshot，验证 JSON 格式和 session 关闭。
- _event_stream：直接驱动 async generator（mock request），验证 SSE 协议格式、keep-alive、错误恢复。
- 端点注册：验证路由存在 + response headers。
不依赖 DB，不需要 TEST_DATABASE_URL。
"""
import asyncio
import json
import os
from unittest.mock import MagicMock, patch

# 占位 DATABASE_URL：让 Settings 校验通过
os.environ.setdefault("DATABASE_URL", "sqlite:///placeholder.db")

import pytest

FAKE_EMPLOYEES = [
    {
        "employee_id": 1,
        "name": "报表快递员",
        "display_status": "WORKING",
        "busy_level": "NORMAL",
        "virtual_progress": 42.5,
    }
]


# ─── _build_snapshot_sync 单测 ────────────────────────────────────────────────


def test_build_snapshot_sync_returns_valid_json():
    """返回合法 JSON，包含 server_time 和 employees。"""
    mock_db = MagicMock()
    with (
        patch("app.api.v1.endpoints.digital_office.SessionLocal", return_value=mock_db),
        patch("app.api.v1.endpoints.digital_office.build_wall_snapshot", return_value=FAKE_EMPLOYEES),
    ):
        from app.api.v1.endpoints.digital_office import _build_snapshot_sync

        raw = _build_snapshot_sync()
        data = json.loads(raw)
        assert "server_time" in data
        assert data["employees"] == FAKE_EMPLOYEES
        mock_db.close.assert_called_once()


def test_build_snapshot_sync_closes_session_on_error():
    """build_wall_snapshot 抛异常时 session 仍然关闭。"""
    mock_db = MagicMock()
    with (
        patch("app.api.v1.endpoints.digital_office.SessionLocal", return_value=mock_db),
        patch("app.api.v1.endpoints.digital_office.build_wall_snapshot", side_effect=RuntimeError("boom")),
    ):
        from app.api.v1.endpoints.digital_office import _build_snapshot_sync

        with pytest.raises(RuntimeError, match="boom"):
            _build_snapshot_sync()
        mock_db.close.assert_called_once()


# ─── _event_stream async generator 测试 ──────────────────────────────────────


def _make_mock_request(disconnected_after: int = 999):
    """创建 mock Request，前 N 次 is_disconnected 返回 False，之后返回 True。"""
    request = MagicMock()
    call_count = 0

    async def is_disconnected():
        nonlocal call_count
        call_count += 1
        return call_count > disconnected_after

    request.is_disconnected = is_disconnected
    return request


async def _collect_stream_chunks(request, max_chunks: int = 10) -> list[str]:
    """驱动 _event_stream generator，收集前 max_chunks 个 yield。"""
    from app.api.v1.endpoints.digital_office import _event_stream

    chunks = []
    gen = _event_stream(request)
    try:
        for _ in range(max_chunks):
            chunk = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
            chunks.append(chunk)
    except (StopAsyncIteration, asyncio.TimeoutError):
        pass
    finally:
        await gen.aclose()
    return chunks


def test_event_stream_emits_snapshot_event():
    """第一个 yield 必须是 event: snapshot + data: {...}。"""
    fake_json = json.dumps({"server_time": "x", "employees": FAKE_EMPLOYEES})
    request = _make_mock_request(disconnected_after=1)

    with (
        patch("app.api.v1.endpoints.digital_office._build_snapshot_sync", return_value=fake_json),
        patch("app.api.v1.endpoints.digital_office.TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(
            _collect_stream_chunks(request, max_chunks=3)
        )

    assert len(chunks) >= 1
    assert chunks[0].startswith("event: snapshot\n")
    assert "data: " in chunks[0]
    payload = json.loads(chunks[0].split("data: ", 1)[1].strip())
    assert payload["employees"][0]["name"] == "报表快递员"


def test_event_stream_emits_keep_alive():
    """snapshot 之后必须跟 keep-alive 注释行。"""
    fake_json = json.dumps({"server_time": "x", "employees": []})
    request = _make_mock_request(disconnected_after=1)

    with (
        patch("app.api.v1.endpoints.digital_office._build_snapshot_sync", return_value=fake_json),
        patch("app.api.v1.endpoints.digital_office.TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(
            _collect_stream_chunks(request, max_chunks=3)
        )

    assert any("keep-alive" in c for c in chunks), f"missing keep-alive in {chunks}"


def test_event_stream_survives_tick_error():
    """_build_snapshot_sync 抛异常时发 tick-error 注释行，流不断。"""
    fake_json = json.dumps({"server_time": "x", "employees": FAKE_EMPLOYEES})
    call_count = 0

    def flaky():
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("DB exploded")
        return fake_json

    request = _make_mock_request(disconnected_after=2)

    with (
        patch("app.api.v1.endpoints.digital_office._build_snapshot_sync", side_effect=flaky),
        patch("app.api.v1.endpoints.digital_office.TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(
            _collect_stream_chunks(request, max_chunks=6)
        )

    assert any("tick-error" in c for c in chunks), f"missing tick-error in {chunks}"
    # 第二个 tick 成功 → 有 snapshot data
    assert any("data: " in c for c in chunks), f"stream died after error: {chunks}"


def test_event_stream_stops_on_disconnect():
    """客户端断连后 generator 退出。"""
    fake_json = json.dumps({"server_time": "x", "employees": []})
    # 第一次 is_disconnected 就返回 True
    request = _make_mock_request(disconnected_after=0)

    with (
        patch("app.api.v1.endpoints.digital_office._build_snapshot_sync", return_value=fake_json),
        patch("app.api.v1.endpoints.digital_office.TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(
            _collect_stream_chunks(request, max_chunks=5)
        )

    assert len(chunks) == 0, f"expected no chunks after disconnect, got {chunks}"


# ─── 端点注册 + headers 测试 ─────────────────────────────────────────────────


def test_office_stream_route_registered():
    """路由 /digital-employees/office/stream 已注册。"""
    from app.api.v1.endpoints.digital_office import router

    routes = [r.path for r in router.routes]
    assert "/digital-employees/office/stream" in routes


def test_office_stream_response_headers():
    """office_stream 返回 StreamingResponse，带正确的 SSE headers。"""
    from app.api.v1.endpoints.digital_office import office_stream

    request = _make_mock_request(disconnected_after=0)
    resp = asyncio.run(office_stream(request=request))

    assert resp.media_type == "text/event-stream"
    assert "no-cache" in resp.headers.get("cache-control", "")
    assert resp.headers.get("x-accel-buffering") == "no"
    assert resp.headers.get("connection") == "keep-alive"

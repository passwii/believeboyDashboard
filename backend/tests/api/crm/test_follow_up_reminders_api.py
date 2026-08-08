"""7 天无跟进提醒 SSE 端点测试 (BLF-539)。

策略（仿 tests/api/crm/test_task_reminders_api.py）：
- _fetch_user_follow_up_reminders：直接调用（mock list_user_stale_reminders +
  settings），验证 JSON 字段与 session 关闭。
- _follow_up_reminder_stream：直接驱动 async generator（mock request + mock
  _fetch_user_follow_up_reminders），验证 SSE 协议格式、首次重放、diff 只推新增、
  keep-alive、tick-error 恢复、断连退出。
- 端点注册 + headers：验证路由存在、登录态 401。
不依赖 DB，不需要 TEST_DATABASE_URL。
"""

import asyncio
import json
import os
from unittest.mock import MagicMock, patch

# 占位 DATABASE_URL：让 Settings 校验通过
os.environ.setdefault("DATABASE_URL", "sqlite:///placeholder.db")

import pytest

import app.api.v1.endpoints.crm as crm_mod

FAKE_REMINDERS = [
    {"entity_type": "customer", "entity_id": 1, "name": "旺旺集团", "days": 10},
    {"entity_type": "lead", "entity_id": 2, "name": "李经理", "days": 8},
]


# ─── _fetch_user_follow_up_reminders 单测 ────────────────────────────────────


def test_fetch_user_reminders_builds_payload_and_closes_session():
    """返回 [{entity_type, entity_id, name, days}]，session 用完即关。"""
    with (
        patch(
            "app.api.v1.endpoints.crm.SessionLocal",
            return_value=MagicMock(),
        ) as mock_session,
        patch(
            "app.services.crm.follow_up_reminder_service.list_user_stale_reminders",
            return_value=list(FAKE_REMINDERS),
        ),
        patch("app.core.config.get_settings") as mock_settings,
    ):
        mock_settings.return_value.crm_follow_up_reminder_days = 7
        rows = crm_mod._fetch_user_follow_up_reminders("user-1")

    assert rows == FAKE_REMINDERS
    mock_session.return_value.close.assert_called_once()


# ─── _follow_up_reminder_stream async generator 测试 ─────────────────────────


def _make_mock_request(disconnected_after: int = 999):
    """mock Request：前 N 次 is_disconnected 返回 False，之后返回 True。"""
    request = MagicMock()
    call_count = 0

    async def is_disconnected():
        nonlocal call_count
        call_count += 1
        return call_count > disconnected_after

    request.is_disconnected = is_disconnected
    return request


async def _collect_stream_chunks(
    request, user_id=None, max_chunks: int = 10
) -> list[str]:
    from app.api.v1.endpoints.crm import _follow_up_reminder_stream

    chunks = []
    gen = _follow_up_reminder_stream(request, user_id)
    try:
        for _ in range(max_chunks):
            chunk = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
            chunks.append(chunk)
    except (StopAsyncIteration, asyncio.TimeoutError):
        pass
    finally:
        await gen.aclose()
    return chunks


def test_stream_replays_all_on_first_connect():
    """首次连接重放：当前全部应提醒实体都推。"""
    request = _make_mock_request(disconnected_after=1)

    with (
        patch(
            "app.api.v1.endpoints.crm._fetch_user_follow_up_reminders",
            return_value=FAKE_REMINDERS,
        ),
        patch("app.api.v1.endpoints.crm.FOLLOW_UP_REMINDER_TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(
            _collect_stream_chunks(request, user_id="user-1", max_chunks=6)
        )

    events = [c for c in chunks if c.startswith("event: follow_up_reminder\n")]
    assert len(events) == 2, f"expected 2 reminder events, got {chunks}"
    first = json.loads(events[0].split("data: ", 1)[1].strip())
    assert first == {
        "entity_type": "customer",
        "entity_id": 1,
        "name": "旺旺集团",
        "days": 10,
    }


def test_stream_diffs_and_only_pushes_new_keys():
    """第二次 tick 只推新增 (entity_type, entity_id)（同一连接内不重复轰炸）。"""
    tick1 = list(FAKE_REMINDERS)
    tick2 = list(FAKE_REMINDERS) + [
        {"entity_type": "customer", "entity_id": 3, "name": "新客户", "days": 9}
    ]
    calls = {"n": 0}

    def fake_fetch(user_id):
        calls["n"] += 1
        return tick1 if calls["n"] == 1 else tick2

    request = _make_mock_request(disconnected_after=2)

    with (
        patch(
            "app.api.v1.endpoints.crm._fetch_user_follow_up_reminders",
            side_effect=fake_fetch,
        ),
        patch("app.api.v1.endpoints.crm.FOLLOW_UP_REMINDER_TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(
            _collect_stream_chunks(request, user_id="user-1", max_chunks=6)
        )

    events = [c for c in chunks if c.startswith("event: follow_up_reminder\n")]
    # 第一 tick 2 条 + 第二 tick 仅新增的 1 条（entity 1/2 已在 pushed_keys，不重复）
    assert len(events) == 3, f"expected 3 events total, got {events}"
    last = json.loads(events[-1].split("data: ", 1)[1].strip())
    assert last["entity_id"] == 3


def test_stream_emits_keep_alive():
    """每 tick 后跟 keep-alive 注释行（防代理超时）。"""
    request = _make_mock_request(disconnected_after=1)
    with (
        patch(
            "app.api.v1.endpoints.crm._fetch_user_follow_up_reminders",
            return_value=FAKE_REMINDERS,
        ),
        patch("app.api.v1.endpoints.crm.FOLLOW_UP_REMINDER_TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(_collect_stream_chunks(request, max_chunks=4))
    assert any("keep-alive" in c for c in chunks), f"missing keep-alive in {chunks}"


def test_stream_survives_tick_error():
    """查询抛异常时发 tick-error 注释行，流不断。"""
    call_count = 0

    def flaky(user_id):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("DB exploded")
        return FAKE_REMINDERS

    request = _make_mock_request(disconnected_after=2)
    with (
        patch(
            "app.api.v1.endpoints.crm._fetch_user_follow_up_reminders",
            side_effect=flaky,
        ),
        patch("app.api.v1.endpoints.crm.FOLLOW_UP_REMINDER_TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(_collect_stream_chunks(request, max_chunks=6))

    assert any("tick-error" in c for c in chunks), f"missing tick-error in {chunks}"
    assert any("follow_up_reminder" in c for c in chunks), (
        f"stream died after error: {chunks}"
    )


def test_stream_stops_on_disconnect():
    """客户端断连后 generator 退出。"""
    request = _make_mock_request(disconnected_after=0)
    with (
        patch(
            "app.api.v1.endpoints.crm._fetch_user_follow_up_reminders",
            return_value=FAKE_REMINDERS,
        ),
        patch("app.api.v1.endpoints.crm.FOLLOW_UP_REMINDER_TICK_SECONDS", 0),
    ):
        chunks = asyncio.run(_collect_stream_chunks(request, max_chunks=5))
    assert len(chunks) == 0, f"expected no chunks after disconnect, got {chunks}"


# ─── 端点注册 + headers 测试 ─────────────────────────────────────────────────


def test_follow_up_reminders_stream_route_registered():
    """路由 /crm/follow-ups/reminders/stream 已注册（router prefix=/crm）。"""
    routes = [r.path for r in crm_mod.router.routes]
    assert "/crm/follow-ups/reminders/stream" in routes


def test_follow_up_reminders_stream_requires_auth():
    """未登录访问 → 401/403（router 级 Depends(protected)）。"""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        r = client.get("/api/v1/crm/follow-ups/reminders/stream")
    assert r.status_code in (401, 403)


def test_follow_up_reminders_stream_response_headers():
    """端点返回 StreamingResponse，带正确的 SSE headers。"""
    request = _make_mock_request(disconnected_after=0)
    resp = asyncio.run(
        crm_mod.follow_up_reminders_stream(request=request, user_id="user-1")
    )

    assert resp.media_type == "text/event-stream"
    assert "no-cache" in resp.headers.get("cache-control", "")
    assert resp.headers.get("x-accel-buffering") == "no"
    assert resp.headers.get("connection") == "keep-alive"

"""Phase 3 自动生成会话标题 —— 流式端点单元测试。

覆盖：
1. 首轮默认标题 → 调 generate_conversation_title → done.title_regenerated=True 且 DB 落库
2. 用户自定义标题 → 不调 generate_conversation_title → title_regenerated=False
3. generate_conversation_title 返回 None（provider 未配置 / 失败）→ 不崩，保留默认标题
4. regenerate=True 路径 → 不触发自动标题（且首轮之后不再重算）

复用 TestModel + monkeypatch build_chat_agent（与 test_ai_chat_stream_native.py 一致），
monkeypatch ai_chat_service.generate_conversation_title 验证触发/不触发与 done 事件字段。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app
from app.models.ai_chat import AIConversation
from app.services import ai as ai_chat_service
from app.services.ai.chat import DEFAULT_CONVERSATION_TITLE


@pytest.fixture
def api_key() -> str:
    from app.core.config import get_settings

    return get_settings().api_key


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def db_session() -> Session:
    session = SessionLocal()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def patched_build_chat_agent(monkeypatch):
    """把 build_chat_agent 替换为返回带 TestModel 的 agent（忽略 web_search）。"""
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def fake_build(settings, *, model_name=None, **_):
        return Agent(
            model=TestModel(custom_output_text="你好，已完成。"),
            capabilities=[Thinking()],
            tools=[],
        )

    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)
    return fake_build


def _create_conversation(db_session: Session, *, title, user_id: int = 42) -> int:
    row = AIConversation(user_id=user_id, title=title)
    db_session.add(row)
    db_session.commit()
    return row.id


def _parse_done(body: str) -> dict:
    for line in body.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        if evt.get("type") == "done":
            return evt
    raise AssertionError("no done event found in stream body")


def _stream(client, conv_id, api_key, *, content, **extra) -> str:
    payload = {"content": content, "enable_web_search": False, **extra}
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json=payload,
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 200, f"expected 200, got {resp.status_code}"
        return b"".join(resp.iter_bytes()).decode("utf-8")


def _db_title(db_session: Session, conv_id: int) -> str:
    db_session.expire_all()
    return db_session.get(AIConversation, conv_id).title


# ─── 测试 1：首轮默认标题自动生成 ─────────────────────────────────────────────


def test_autotitle_first_turn_default_title(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    conv_id = _create_conversation(db_session, title=DEFAULT_CONVERSATION_TITLE)
    captured: dict = {}

    def fake_gen(settings, user_content, assistant_content):
        captured["called"] = True
        captured["user"] = user_content
        captured["assistant"] = assistant_content
        return "生成的会话标题"

    monkeypatch.setattr(ai_chat_service, "generate_conversation_title", fake_gen)

    body = _stream(client, conv_id, api_key, content="帮我分析一下销售")
    done = _parse_done(body)

    assert done["title_regenerated"] is True
    assert done["conversation_title"] == "生成的会话标题"
    assert captured.get("called") is True
    # 传入内容应准确（用户消息 + 助手首轮回复）
    assert captured["user"] == "帮我分析一下销售"
    assert "你好，已完成。" in captured["assistant"]
    # DB 已落库
    assert _db_title(db_session, conv_id) == "生成的会话标题"


# ─── 测试 2：用户自定义标题不覆盖 ────────────────────────────────────────────


def test_autotitle_skips_custom_title(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    conv_id = _create_conversation(db_session, title="我的自定义标题")
    captured = {"called": False}

    def fake_gen(*args, **kwargs):
        captured["called"] = True
        return "x"

    monkeypatch.setattr(ai_chat_service, "generate_conversation_title", fake_gen)

    body = _stream(client, conv_id, api_key, content="帮我分析一下销售")
    done = _parse_done(body)

    assert done["title_regenerated"] is False
    assert done["conversation_title"] == "我的自定义标题"
    assert captured["called"] is False
    assert _db_title(db_session, conv_id) == "我的自定义标题"


# ─── 测试 3：generate 返回 None 不崩、保留默认 ───────────────────────────────


def test_autotitle_none_keeps_default(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    conv_id = _create_conversation(db_session, title=DEFAULT_CONVERSATION_TITLE)
    monkeypatch.setattr(ai_chat_service, "generate_conversation_title", lambda *a, **k: None)

    body = _stream(client, conv_id, api_key, content="帮我分析一下销售")
    done = _parse_done(body)

    assert done["title_regenerated"] is False
    assert done["conversation_title"] == DEFAULT_CONVERSATION_TITLE
    assert _db_title(db_session, conv_id) == DEFAULT_CONVERSATION_TITLE


# ─── 测试 4：regenerate 路径不触发 + 仅算一次 ───────────────────────────────


def test_autotitle_skips_regenerate(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    conv_id = _create_conversation(db_session, title=DEFAULT_CONVERSATION_TITLE)
    captured = {"called": False}

    def fake_gen(*args, **kwargs):
        captured["called"] = True
        return "生成的会话标题"

    monkeypatch.setattr(ai_chat_service, "generate_conversation_title", fake_gen)

    # 第一次：普通消息 → 触发
    body1 = _stream(client, conv_id, api_key, content="帮我分析销售")
    done1 = _parse_done(body1)
    assert done1["title_regenerated"] is True
    assert _db_title(db_session, conv_id) == "生成的会话标题"

    # 第二次：regenerate=True → 不应再触发
    captured["called"] = False
    body2 = _stream(
        client, conv_id, api_key, content="重写", enable_web_search=True, regenerate=True
    )
    done2 = _parse_done(body2)
    assert done2["title_regenerated"] is False
    assert captured["called"] is False
    # 标题保持首轮生成值，未被覆盖
    assert _db_title(db_session, conv_id) == "生成的会话标题"

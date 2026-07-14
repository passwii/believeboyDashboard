"""AI Chat 流式端点 e2e（Phase 1 任务 6）。

覆盖：
1. `enable_web_search=False` → Pydantic AI 路径（start → chunk → usage → done，含 assistant_message）
2. `regenerate=True` + `enable_web_search=False` → HTTP 400
3. `enable_web_search=True` → 旧同步路径（monkeypatch stream_with_tool_calling 捕获调用，行为冻结）
4. `attached_file_content` 注入到 system prompt（新建+web_search=False 路径）

用 pydantic_ai TestModel + monkeypatch build_chat_agent，避免依赖外网。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.main import app
from app.services import ai as ai_chat_service  # noqa: E402


@pytest.fixture
def api_key() -> str:
    """从 settings 取真实 API key（与 .env 中的 API_KEY 字段一致）。"""
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
    """把 app.api.v1.endpoints.ai_chat.build_chat_agent 替换为返回带 TestModel 的 agent。

    ⚠️ Pydantic AI 2.9：`Agent.override(...)` 是 context manager，**不**返回新 Agent。
    fake_build 必须直接构造一个 Agent 实例（带 TestModel 与必要的 capabilities）。

    接受 model_name 参数（payload.model 可能传入），实际忽略（TestModel 不区分 model）。
    """
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def fake_build(settings, *, model_name=None, **_):
        return Agent(
            model=TestModel(custom_output_text="你好，已完成。"),
            capabilities=[Thinking()],
            tools=[],
        )

    # 必须 monkeypatch 模块级 name（新 stream_message 在模块顶部 import 才能命中）
    monkeypatch.setattr(
        "app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build
    )
    return fake_build


def _create_conversation(db_session: Session, user_id: int = 42) -> int:
    """建一条最简会话（不写消息），返回 conversation_id。"""
    from app.models.ai_chat import AIConversation

    row = AIConversation(user_id=user_id, title="t")
    db_session.add(row)
    db_session.commit()
    return row.id


def _types_from_body(body: str) -> list[str]:
    """从 ndjson body 提取所有事件 type。"""
    types: list[str] = []
    for line in body.strip().split("\n"):
        if '"type":' in line:
            # 取第一个 "type":"<x>" 片段
            types.append(line.split('"type":')[1].split('"')[1])
    return types


# ─── 测试 1：Pydantic AI 路径事件顺序 ─────────────────────────────────────────


def test_native_path_emits_start_chunk_usage_done_in_order(
    patched_build_chat_agent, client, db_session, api_key
):
    """enable_web_search=False → 新 Pydantic AI 路径 → start/chunk/usage/done 顺序，done 含 assistant_message。"""
    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "你好", "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.read()}"
        body = b"".join(resp.iter_bytes()).decode("utf-8")

    types = _types_from_body(body)
    assert types[0] == "start", f"first event should be start, got {types}"
    assert "chunk" in types, f"missing chunk event: {types}"
    assert "usage" in types, f"missing usage event: {types}"
    assert types[-1] == "done", f"last event should be done, got {types}"

    # done 事件 payload 含 assistant_message
    done_line = next(
        (line for line in body.split("\n") if '"done"' in line and '"type"' in line),
        None,
    )
    assert done_line is not None, "no done event in body"
    assert '"assistant_message"' in done_line
    assert '"user_message"' in done_line


# ─── 测试 2：路由矩阵——regenerate + no web_search → 400 ──────────────────────


def test_regenerate_with_web_search_false_returns_400(patched_build_chat_agent, client, db_session, api_key):
    """regenerate=True + enable_web_search=False → HTTP 400（Phase 1 简化：此组合不支持）。

    先 populate 一条 user + assistant 历史（否则会因为 len(history) < 2 触发
    旧的 400 "没有可重新生成的消息"，无法区分两个 400 来源）。
    """
    from app.models.ai_chat import AIMessage

    conv_id = _create_conversation(db_session)
    db_session.add(AIMessage(conversation_id=conv_id, role="user", content="hi"))
    db_session.add(AIMessage(conversation_id=conv_id, role="assistant", content="hello", is_complete=True))
    db_session.commit()

    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "再生成", "regenerate": True, "enable_web_search": False},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 400
        body = b"".join(resp.iter_bytes()).decode("utf-8")
    # 进一步校验错误信息：必须是"重新生成仅在启用联网搜索时支持"
    assert "联网搜索" in body or "web_search" in body.lower(), (
        f"unexpected error message: {body[:200]}"
    )


# ─── 测试 3：enable_web_search=True → Pydantic AI native Tavily tool 路径 ─────


def test_web_search_true_uses_pydantic_ai_tavily_tool(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    """[Phase 2 任务 5] enable_web_search=True 必须走 Pydantic AI 路径 + Tavily tool。

    与 Phase 1 不同：旧 `_legacy_stream_response` 已删除，所有 web_search 用户
    也走 Pydantic AI driver，由 agent 自动调用 tavily_search 工具。

    校验：必须出现 tool_calls / tool_searching / sources / tool_done 事件序列。
    """
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def fake_build(settings, *, model_name=None, web_search=False, **_):
        # 注册一个 mock tavily_search 工具（TestModel 需要工具真的存在才能调用）
        # 返回 list[dict] 而非 JSON 字符串（与 Pydantic AI tavily_search_tool 实际返回一致）
        async def tavily_search(ctx, query: str) -> list[dict]:
            return [
                {"title": "Mock result", "url": "https://mock.com", "content": "Mock content", "score": 0.9}
            ]

        return Agent(
            model=TestModel(call_tools=["tavily_search"], custom_output_text="已搜索。"),
            capabilities=[Thinking()],
            tools=[tavily_search],
        )

    monkeypatch.setattr(
        "app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build
    )

    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "今天北京天气", "enable_web_search": True},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 200, f"expected 200, got {resp.status_code}"
        body = b"".join(resp.iter_bytes()).decode("utf-8")

    types = _types_from_body(body)
    # Phase 2 强制：web_search=True 走 Pydantic AI Tavily tool，必须触发完整事件序列
    assert "start" in types, f"缺 start 事件: {types}"
    assert "tool_calls" in types, f"缺 tool_calls 事件（Tavily tool 未触发）: {types}"
    assert "tool_searching" in types, f"缺 tool_searching 事件（端点层未 yield）: {types}"
    assert "sources" in types, f"缺 sources 事件: {types}"
    assert "tool_done" in types, f"缺 tool_done 事件: {types}"
    assert "chunk" in types, f"缺 chunk 事件: {types}"
    assert "done" in types, f"缺 done 事件: {types}"


def test_web_search_true_does_not_call_legacy_stream_with_tool_calling(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    """[Phase 2 任务 5] enable_web_search=True 不再调用 `stream_with_tool_calling`（legacy 已删）。"""
    from app.services import ai as ai_module

    captured = {"called": False}
    real_func = ai_module.stream_with_tool_calling

    def fake_stream_with_tool_calling(**kwargs):
        captured["called"] = True
        return real_func(**kwargs)

    monkeypatch.setattr(ai_module, "stream_with_tool_calling", fake_stream_with_tool_calling)

    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def fake_build(settings, *, model_name=None, web_search=False, **_):
        return Agent(
            model=TestModel(call_tools=["tavily_search"], custom_output_text="ok"),
            capabilities=[Thinking()],
            tools=[],
        )

    monkeypatch.setattr("app.api.v1.endpoints.ai_chat.build_chat_agent", fake_build)

    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={"content": "今天天气", "enable_web_search": True},
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        resp.read()

    assert not captured["called"], (
        "Phase 2 已删 legacy 路径，stream_with_tool_calling 不应再被调用"
    )


# ─── 测试 4：attached_file_content 注入 ─────────────────────────────────────


def test_attached_file_content_injected_into_system_prompt(
    patched_build_chat_agent, client, db_session, api_key, monkeypatch
):
    """attached_file_content 应注入到 system_prompt（prompt 末尾追加 system 消息）。

    这里只做"请求成功 + done 事件含 assistant_message + user_message" 的烟雾测试；
    真正的 Pydantic AI prompt 内容校验留给 Phase 2 e2e（prompt 注入策略以 mapper 行为为准）。
    """
    from pydantic_ai import Agent
    from pydantic_ai.capabilities import Thinking
    from pydantic_ai.models.test import TestModel

    def capturing_build(settings, *, model_name=None, **_):
        return Agent(
            model=TestModel(custom_output_text="已读取附件"),
            capabilities=[Thinking()],
            tools=[],
        )

    monkeypatch.setattr(
        "app.api.v1.endpoints.ai_chat.build_chat_agent", capturing_build
    )

    conv_id = _create_conversation(db_session)
    with client.stream(
        "POST",
        f"/api/v1/ai/conversations/{conv_id}/messages/stream",
        json={
            "content": "总结附件",
            "enable_web_search": False,
            "attached_file_name": "Q3.txt",
            "attached_file_content": "Q3 营收 ¥1.2M，环比 +12%。",
        },
        headers={"X-User-Id": "42", "X-API-Key": api_key},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join(resp.iter_bytes()).decode("utf-8")

    types = _types_from_body(body)
    assert "start" in types and "done" in types

    done_line = next(
        (line for line in body.split("\n") if '"done"' in line and '"type"' in line),
        None,
    )
    assert done_line is not None
    assert '"assistant_message"' in done_line
    assert '"user_message"' in done_line


# ─── 单元测试：prompt → Pydantic AI run_stream_events 参数转换 ─────────────


def test_prompt_messages_to_pydantic_ai_args_only_user():
    """单条 user 消息 → user_prompt=str, message_history=[]。"""
    from app.api.v1.endpoints.ai_chat import _prompt_messages_to_pydantic_ai_args

    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args(
        [{"role": "user", "content": "hi"}]
    )
    assert user_prompt == "hi"
    assert message_history == []


def test_prompt_messages_to_pydantic_ai_args_with_assistant_history():
    """user + 历史 assistant → user_prompt 是 user，历史 assistant 进 message_history。"""
    from app.api.v1.endpoints.ai_chat import _prompt_messages_to_pydantic_ai_args
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args([
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": "你好！"},
        {"role": "user", "content": "今天天气"},
    ])
    assert user_prompt == "今天天气"  # 最后一条 user
    assert len(message_history) == 2  # 之前的 user + assistant
    # 第 0 个：原 user → ModelRequest + UserPromptPart
    assert isinstance(message_history[0], ModelRequest)
    assert isinstance(message_history[0].parts[0], UserPromptPart)
    assert message_history[0].parts[0].content == "你好"
    # 第 1 个：原 assistant → ModelResponse + TextPart
    assert isinstance(message_history[1], ModelResponse)
    assert isinstance(message_history[1].parts[0], TextPart)
    assert message_history[1].parts[0].content == "你好！"


def test_prompt_messages_to_pydantic_ai_args_with_system_in_history():
    """system 消息进 message_history（作为 ModelRequest）。"""
    from app.api.v1.endpoints.ai_chat import _prompt_messages_to_pydantic_ai_args
    from pydantic_ai.messages import ModelRequest, SystemPromptPart

    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args([
        {"role": "system", "content": "be helpful"},
        {"role": "user", "content": "hi"},
    ])
    assert user_prompt == "hi"
    assert len(message_history) == 1
    assert isinstance(message_history[0], ModelRequest)
    assert isinstance(message_history[0].parts[0], SystemPromptPart)


def test_prompt_messages_to_pydantic_ai_args_skips_unknown_role():
    """防御性：未知 role 跳过。"""
    from app.api.v1.endpoints.ai_chat import _prompt_messages_to_pydantic_ai_args

    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args([
        {"role": "user", "content": "hi"},
        {"role": "function_call", "content": "skip me"},
    ])
    assert user_prompt == "hi"
    assert message_history == []


# ─── PR review fix：attached_file 在新/旧两条路径都不再丢失 ─────────────────


def test_prompt_messages_to_pydantic_ai_args_folds_attached_file_into_user_prompt():
    """[Kilo WARNING] post-user system 消息（attached_file 提示）必须折叠进 user_prompt。

    之前的实现 `prompt_messages[:last_user_idx]` 会把 last_user 之后追加的 system 消息
    静默丢掉；现在改为 fold-to-prefix。
    """
    from app.api.v1.endpoints.ai_chat import _prompt_messages_to_pydantic_ai_args

    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args([
        {"role": "user", "content": "总结附件"},
        {
            "role": "system",
            "content": "【用户附加文件：Q3.txt】\nQ3 营收 ¥1.2M，环比 +12%。\n请根据上述附加文件内容回答用户问题。",
        },
    ])
    # attached_file 内容必须出现在 user_prompt 前缀
    assert "Q3 营收" in user_prompt
    assert "总结附件" in user_prompt
    assert user_prompt.index("Q3 营收") < user_prompt.index("总结附件")
    # post-user system 消息不进 message_history
    assert message_history == []


def test_prompt_messages_to_pydantic_ai_args_attached_file_with_history():
    """带历史的 attached_file：历史 user/assistant 进 message_history，attached_file 仍 fold 进 user_prompt。"""
    from app.api.v1.endpoints.ai_chat import _prompt_messages_to_pydantic_ai_args
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart

    user_prompt, message_history = _prompt_messages_to_pydantic_ai_args([
        {"role": "user", "content": "原问题"},
        {"role": "assistant", "content": "原回答"},
        {"role": "user", "content": "现在呢"},
        {"role": "system", "content": "【文件片段】数据 X=42"},
    ])
    # 历史 2 条进 message_history
    assert len(message_history) == 2
    assert isinstance(message_history[0], ModelRequest)
    assert isinstance(message_history[0].parts[0], UserPromptPart)
    assert message_history[0].parts[0].content == "原问题"
    assert isinstance(message_history[1], ModelResponse)
    assert isinstance(message_history[1].parts[0], TextPart)
    assert message_history[1].parts[0].content == "原回答"
    # user_prompt = file_prefix + 现在的 user
    assert "数据 X=42" in user_prompt
    assert "现在呢" in user_prompt
    assert user_prompt.index("数据 X=42") < user_prompt.index("现在呢")



"""Agent Factory 单测。

Phase 1 任务 5：build_chat_agent + current_date_instruction。
Phase 1 工厂**不**注册 tools（web_search 推迟 Phase 2），仅 Thinking capability + 动态 current_date 指令。

不依赖真实 LLM（用 type('S', (), {})() 伪造 settings）。

> ⚠️ Pydantic AI 2.9 API 变化（vs plan 写的 2.8）：
> - `agent.tools` 不存在；改用 `agent.toolsets`
> - `agent.capabilities` 不存在；改用 `agent.root_capability.capabilities`
"""
from __future__ import annotations

from datetime import datetime
from unittest.mock import patch

from pydantic_ai import Agent
from pydantic_ai.capabilities import Thinking

from app.services.ai.agent import build_chat_agent, current_date_instruction


def _fake_settings(
    model: str = "gpt-4",
    api_key: str = "test-key",
    base_url: str = "https://api.openai.com/v1",
    web_search_base_url: str = "https://search.believeboy.com",
    web_search_api_key: str = "test-search-key",
):
    s = type("S", (), {})()
    s.ai_chat_default_model = model
    s.ai_chat_provider_api_key = api_key
    s.ai_chat_provider_base_url = base_url
    s.ai_chat_web_search_base_url = web_search_base_url
    s.ai_chat_web_search_api_key = web_search_api_key
    return s


def test_current_date_instruction_returns_today_date():
    """动态指令注入今天日期（YYYY-MM-DD）。"""
    fixed = datetime(2026, 7, 10)
    with patch("app.services.ai.agent.datetime") as mock_dt:
        mock_dt.now.return_value = fixed
        out = current_date_instruction(ctx=None)
    assert "2026-07-10" in out


def test_build_chat_agent_returns_pydantic_ai_agent_instance():
    """build_chat_agent 应返回 pydantic_ai.Agent 实例。"""
    agent = build_chat_agent(_fake_settings())
    assert isinstance(agent, Agent)


def test_build_chat_agent_registers_no_user_tools_phase1():
    """Phase 1 工厂不注册用户 tool：仅 Pydantic AI 默认的输出 schema toolset。

    Pydantic AI 2.x 自动给 str output_type 加一个 _AgentFunctionToolset；
    用户 tool 通过 `tools=[...]` 显式注册。Phase 1 不传，所以用户 toolset 数为 0。
    """
    agent = build_chat_agent(_fake_settings())
    user_toolsets = [
        t for t in agent.toolsets
        if getattr(t, "toolset", None) is not None  # 默认 output_schema toolset 的 toolset=None
    ]
    assert user_toolsets == [], f"Phase 1 不应有用户 toolset，实际: {user_toolsets}"


def test_build_chat_agent_uses_settings_provider_base_url():
    """自定义 base_url 传入时应不抛错（实际 provider 实例校验放 e2e）。"""
    settings = _fake_settings(base_url="https://custom.example.com/v1")
    agent = build_chat_agent(settings)
    assert isinstance(agent, Agent)


def test_build_chat_agent_includes_thinking_capability():
    """工厂应注册 Thinking capability（在 root_capability.capabilities 里）。"""
    agent = build_chat_agent(_fake_settings())
    caps = agent.root_capability.capabilities
    assert any(isinstance(c, Thinking) for c in caps), f"Thinking capability missing in {caps}"


def test_build_chat_agent_with_extra_instructions_merges_them():
    """传入额外 instructions 应与 base_instructions 合并（顺序由调用方控制）。"""
    agent = build_chat_agent(_fake_settings(), instructions=["你是 domain 专家。"])
    # _instructions 是 Pydantic AI Agent 内部 list
    instr = agent._instructions  # type: ignore[attr-defined]
    assert "你是 domain 专家。" in instr
    # 动态 current_date 指令也应被包含（保持原行为）
    assert current_date_instruction in instr


# ─── Phase 2 任务 4：web_search=True 注册 tavily_search_tool ──────────────────


def _agent_tool_names(agent: Agent) -> set[str]:
    """收集 agent 全部 toolset 里的 tool 名字。

    Pydantic AI 2.9：`agent.tools` 不存在；工具在 `agent.toolsets[].tools` dict 里。
    """
    names: set[str] = set()
    for ts in agent.toolsets:
        tools = getattr(ts, "tools", {}) or {}
        names.update(tools.keys())
    return names


def test_build_chat_agent_without_web_search_has_no_tavily_tool():
    """[Phase 2] 默认 web_search=False → factory 不注册 tavily_search。"""
    agent = build_chat_agent(_fake_settings(), web_search=False)
    tool_names = _agent_tool_names(agent)
    assert "tavily_search" not in tool_names, (
        f"web_search=False 时不应有 tavily_search，实际: {tool_names}"
    )


def test_build_chat_agent_with_web_search_registers_tavily_tool():
    """[Phase 2] web_search=True → factory 注册 tavily_search 工具。"""
    agent = build_chat_agent(_fake_settings(web_search_base_url="https://search.believeboy.com"), web_search=True)
    tool_names = _agent_tool_names(agent)
    assert "tavily_search" in tool_names, f"web_search=True 应有 tavily_search，实际: {tool_names}"


def test_build_chat_agent_with_web_search_uses_searxng_base_url():
    """[Phase 2] factory 用 settings.ai_chat_web_search_base_url（不是 hardcode api.tavily.com）。

    通过 spy AsyncTavilyClient 构造验证：传给 client 的参数必须等于 settings。
    """
    from unittest.mock import patch

    settings = _fake_settings()
    settings.ai_chat_web_search_base_url = "https://custom-searxng.example.com"
    settings.ai_chat_web_search_api_key = "custom-key"

    captured_kwargs: dict = {}

    def fake_async_tavily_client(**kwargs):
        captured_kwargs.update(kwargs)
        return MagicMock_noop()

    class MagicMock_noop:
        """占位 client，避免 tavily_search_tool 内部访问 client 属性时炸。"""

        def __getattr__(self, name):
            return lambda *a, **kw: None

    with patch("app.services.ai.agent.AsyncTavilyClient", side_effect=fake_async_tavily_client):
        build_chat_agent(settings, web_search=True)

    # 验证传给 AsyncTavilyClient 的参数（spike 揭示：参数名是 api_base_url 不是 base_url）
    assert captured_kwargs.get("api_base_url") == "https://custom-searxng.example.com", (
        f"AsyncTavilyClient.api_base_url 应是 settings.ai_chat_web_search_base_url，实际: {captured_kwargs}"
    )
    assert captured_kwargs.get("api_key") == "custom-key"
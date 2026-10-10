"""Phase 1 任务 1：pydantic-ai 依赖存在性单测。

写入 requirements.txt 与安装之前该测试应 FAIL；安装 `pydantic-ai==2.9.0` 后 PASS。
（2026-07-12 从 2.8.0 升到 2.9.0 时同步更新断言。）
"""

from __future__ import annotations


def test_pydantic_ai_importable():
    import pydantic_ai

    assert pydantic_ai is not None


def test_pydantic_ai_messages_importable():
    """关键子模块导入检查：Phase 1 mapper 依赖 `pydantic_ai.messages` 中的 PartDeltaEvent / TextPartDelta 等。"""
    from pydantic_ai import messages

    assert hasattr(messages, "PartDeltaEvent")
    assert hasattr(messages, "TextPartDelta")
    assert hasattr(messages, "ThinkingPartDelta")


def test_pydantic_ai_agent_run_result_event_importable():
    """Phase 1 mapper 还依赖 `pydantic_ai.AgentRunResultEvent` 读取 usage。"""
    from pydantic_ai import AgentRunResultEvent

    assert AgentRunResultEvent is not None


def test_pydantic_ai_capabilities_thinking_importable():
    """Phase 1 factory 依赖 `pydantic_ai.capabilities.Thinking`。"""
    from pydantic_ai.capabilities import Thinking

    assert Thinking is not None


def test_pydantic_ai_openai_provider_importable():
    """Phase 1 factory 依赖 `pydantic_ai.providers.openai.OpenAIProvider`。"""
    from pydantic_ai.providers.openai import OpenAIProvider

    assert OpenAIProvider is not None
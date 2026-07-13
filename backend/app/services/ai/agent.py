"""Pydantic AI Agent 工厂。

Phase 1：构造不带 tools 的 Agent（web_search 走旧 httpx 路径兜底）。
- Thinking capability：保留现状 ai_chat 的推理行为
- current_date_instruction：动态指令注入今天日期，供模型时间锚定

Phase 2：追加 tavily_search_tool 注册与对应指令，把 web_search 用户路径切到 Pydantic AI driver。

> ⚠️ Pydantic AI 2.9 API：
> - capabilities 参数接受 list[Capability]；传入 Thinking() 即生效
> - tools=[] 显式声明，避免引入默认 toolset
> - provider 通过 OpenAIProvider(api_key=, base_url=) 接入既有 base_url
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import Thinking
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from app.core.config import Settings


def current_date_instruction(ctx: RunContext | None) -> str:
    """Pydantic AI 动态指令：注入今天的日期，供模型时间锚定。

    接受 `ctx` 是为符合 Pydantic AI 动态指令 callable 签名；本函数不使用 ctx。
    """
    return f"今天的日期是 {datetime.now().strftime('%Y-%m-%d')}。回答涉及时间时请以此为参照。"


def _build_model(settings: Settings, model_name: Optional[str] = None) -> OpenAIChatModel:
    """用 settings 既有 provider 字段构造 OpenAI 兼容的模型实例。

    `model_name` 优先于 `settings.ai_chat_default_model`，用于支持端点 payload 覆盖。
    """
    name = (model_name or settings.ai_chat_default_model).strip()
    return OpenAIChatModel(
        name,
        provider=OpenAIProvider(
            api_key=settings.ai_chat_provider_api_key,
            base_url=settings.ai_chat_provider_base_url,
        ),
    )


def build_chat_agent(
    settings: Settings,
    instructions: Optional[Iterable] = None,
    model_name: Optional[str] = None,
) -> Agent:
    """构造 Pydantic AI Agent。

    Phase 1：不注册用户 tools（web_search 走旧 httpx 路径）；仅 Thinking capability。
    Phase 2：追加 tavily_search_tool 注册与对应指令。

    `instructions` 由调用方按需注入（prepend 在 base 之前；调用方控制优先级）。
    `model_name` 覆盖 settings 默认 model（来自 MessageCreate.payload.model）。
    """
    model = _build_model(settings, model_name=model_name)
    base_instructions: list = [
        "你是一个有用的 AI 助手，回答简洁准确。",
        current_date_instruction,
    ]
    merged_instructions: list = list(instructions) if instructions else []
    return Agent(
        model=model,
        instructions=merged_instructions + base_instructions,
        capabilities=[Thinking()],
        tools=[],
    )
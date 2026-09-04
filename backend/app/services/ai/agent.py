"""Pydantic AI Agent 工厂。

Phase 1：构造不带 tools 的 Agent（web_search 走旧 httpx 路径兜底）。
- Thinking capability：保留现状 ai_chat 的推理行为
- current_date_instruction：动态指令注入今天日期，供模型时间锚定

Phase 2：追加 tavily_search_tool 注册与对应指令，把 web_search 用户路径切到 Pydantic AI driver。
- web_search=True 时注册 Pydantic AI 自带 `tavily_search_tool`
- client 用 settings.ai_chat_web_search_base_url（指向 SearXNG adapter）
- 追加 web_search 行为指令，提示模型何时调用工具

> ⚠️ Pydantic AI 2.9 API：
> - capabilities 参数接受 list[Capability]；传入 Thinking() 即生效
> - tools=[] 显式声明，避免引入默认 toolset
> - provider 通过 OpenAIProvider(api_key=, base_url=) 接入既有 base_url

> ⚠️ tavily-python 0.7.x 参数名是 `api_base_url`（不是 `base_url`），
> 这是 spike 实测揭示的细节；与 Pydantic AI `tavily_search_tool` 文档示例的
> `base_url=` 参数不一致。
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from pydantic_ai import Agent, RunContext
from pydantic_ai.capabilities import Thinking
from pydantic_ai.common_tools.tavily import tavily_search_tool
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from tavily import AsyncTavilyClient

from app.core.config import Settings


_WEB_SEARCH_INSTRUCTION = (
    "当用户问题涉及实时信息（天气、新闻、价格、事件等）时，"
    "必须调用 tavily_search 工具获取最新数据，不要凭记忆回答。"
)


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


def _build_tavily_search_tool(settings: Settings):
    """构造 Pydantic AI Tavily 搜索工具，client 指向 SearXNG Tavily adapter。

    client 参数必须是 `api_base_url=`（不是 `base_url=`，spike 实测揭示）。
    """
    client = AsyncTavilyClient(
        api_key=settings.ai_chat_web_search_api_key,
        api_base_url=settings.ai_chat_web_search_base_url,
    )
    return tavily_search_tool(client=client)


def build_chat_agent(
    settings: Settings,
    instructions: Optional[Iterable] = None,
    model_name: Optional[str] = None,
    web_search: bool = False,
) -> Agent:
    """构造 Pydantic AI Agent。

    Phase 1：不注册用户 tools（web_search 走旧 httpx 路径）；仅 Thinking capability。
    Phase 2：`web_search=True` 时注册 tavily_search_tool（client 指向 SearXNG adapter），
              同步追加 web_search 行为指令（提示模型何时调用工具）。

    `instructions` 由调用方按需注入（prepend 在 base 之前；调用方控制优先级）。
    `model_name` 覆盖 settings 默认 model（来自 MessageCreate.payload.model）。
    """
    model = _build_model(settings, model_name=model_name)
    base_instructions: list = [
        "你是一个有用的 AI 助手，回答简洁准确。",
        current_date_instruction,
    ]
    extra_instructions: list = list(instructions) if instructions else []
    if web_search:
        extra_instructions.append(_WEB_SEARCH_INSTRUCTION)

    tools: list = []
    if web_search:
        tools.append(_build_tavily_search_tool(settings))

    return Agent(
        model=model,
        instructions=extra_instructions + base_instructions,
        capabilities=[Thinking()],
        tools=tools,
    )
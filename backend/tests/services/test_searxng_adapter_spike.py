"""SearXNG Tavily adapter 兼容性 spike 固化（Phase 2 任务 1 步骤 4）。

把 spike 的关键断言固化为单测，防回归：
- AsyncTavilyClient(api_key=, api_base_url=settings.ai_chat_web_search_base_url).search() 必须返回 dict
- dict['results'] 是 list
- 每个 result 含 title / url / content 字段（score / raw_content 可选）

依赖外网 SearXNG adapter；CI 环境用 SKIP_SEARXNG_SPIKE=1 跳过。
"""
from __future__ import annotations

import asyncio
import os

import pytest


SEARXNG_SPIKE_QUERY = os.environ.get("SEARXNG_SPIKE_QUERY", "Pydantic AI")
SKIP_SEARXNG_SPIKE = os.environ.get("SKIP_SEARXNG_SPIKE", "0") == "1"


pytestmark = pytest.mark.skipif(
    SKIP_SEARXNG_SPIKE,
    reason="SKIP_SEARXNG_SPIKE=1 — SearXNG adapter 测试在 CI 跳过",
)


async def _call_searxng_adapter(query: str) -> object:
    """直接调 AsyncTavilyClient，命中 SearXNG Tavily adapter。"""
    from app.core.config import get_settings
    from tavily import AsyncTavilyClient

    settings = get_settings()
    client = AsyncTavilyClient(
        api_key=settings.ai_chat_web_search_api_key,
        api_base_url=settings.ai_chat_web_search_base_url,
    )
    try:
        return await client.search(
            query=query,
            search_depth="advanced",
            topic="general",
            time_range=None,
            max_results=5,
        )
    finally:
        await client.close()


def test_searxng_adapter_response_is_dict():
    """SearXNG adapter 响应必须是 dict（Tavily API 标准格式）。"""
    raw = asyncio.run(_call_searxng_adapter(SEARXNG_SPIKE_QUERY))
    assert isinstance(raw, dict), (
        f"adapter response 应为 dict，实际 {type(raw).__name__}；"
        f"样例：{str(raw)[:200]}"
    )


def test_searxng_adapter_has_results_list():
    """dict 必须含 'results' 字段，且是 list。"""
    raw = asyncio.run(_call_searxng_adapter(SEARXNG_SPIKE_QUERY))
    assert isinstance(raw, dict)
    assert "results" in raw, f"响应缺 'results' 字段；实际 keys: {list(raw.keys())}"
    assert isinstance(raw["results"], list), (
        f"'results' 不是 list，实际 {type(raw['results']).__name__}"
    )


def test_searxng_adapter_results_have_required_keys():
    """每个 result 必须含 title / url / content（TavilySearchResult 要求字段）。"""
    raw = asyncio.run(_call_searxng_adapter(SEARXNG_SPIKE_QUERY))
    assert isinstance(raw, dict)
    results = raw["results"]
    assert results, "results 不能为空（adapter 异常或 query 太冷门）"
    required_keys = {"title", "url", "content"}
    for i, item in enumerate(results):
        assert isinstance(item, dict), f"results[{i}] 不是 dict"
        actual = set(item.keys())
        missing = required_keys - actual
        assert not missing, f"results[{i}] 缺关键字段 {missing}；实际 keys: {actual}"
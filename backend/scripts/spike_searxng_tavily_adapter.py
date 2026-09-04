"""SearXNG Tavily adapter 格式 spike（Phase 2 任务 1 · 必做前置）。

目的：决定 mapper `_handle_tool_result` 解析 content 的路径（dict vs list[dict]），
     以及能否直接用 Pydantic AI 自带的 `tavily_search_tool`，还是写自定义 tool 函数。

原理：
- tavily-python 的 `AsyncTavilyClient.search()` 默认 POST 到 `https://api.tavily.com/search`
- 本仓库的 `AI_CHAT_WEB_SEARCH_BASE_URL=https://search.believeboy.com` 是一个 SearXNG adapter
- adapter 是否严格兼容 Tavily API 协议未知 → spike 验证

运行：
    cd backend && DATABASE_URL=... ./.venv/bin/python scripts/spike_searxng_tavily_adapter.py

输出：
    - 实际请求 URL / payload / headers
    - 实际响应 body（首 1000 字符）
    - 兼容性结论：FITS_TAVILY_TOOL / NEEDS_CUSTOM_TOOL

退出码：
    0 = 兼容 Tavily 原生工具（dict['results'][i] 含 title/url/content/score）
    1 = 响应不是 dict，Tavily 原生工具不兼容，需写自定义 tool
    2 = 响应是 dict 但 results 为空（可能是 SearXNG 暂未抓取到结果；用更通用 query 复测）
    3 = results 缺关键字段（title/url/content/score 之一）
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))


async def _call_tavily_client(query: str, time_range: str | None = None) -> dict:
    """直接调 AsyncTavilyClient.search() 命中 SearXNG adapter，记录实际响应。"""
    from tavily import AsyncTavilyClient

    base_url = os.environ.get("AI_CHAT_WEB_SEARCH_BASE_URL", "https://search.believeboy.com")
    api_key = os.environ.get("AI_CHAT_WEB_SEARCH_API_KEY", "dummy")
    # 注：tavily-python 0.7.x 的参数名是 `api_base_url`（不是 `base_url`）
    client = AsyncTavilyClient(api_key=api_key, api_base_url=base_url)
    try:
        raw = await client.search(
            query=query,
            search_depth="advanced",
            topic="general",
            time_range=time_range,
            max_results=5,
        )
    finally:
        await client.close()
    return raw


def _diagnose(raw: object) -> tuple[int, str]:
    """分析响应格式，返回 (exit_code, summary_message)。"""
    # 情况 1：响应不是 dict
    if not isinstance(raw, dict):
        sample = str(raw)[:200]
        return 1, f"响应类型 {type(raw).__name__}（非 dict）；Tavily 原生工具不兼容。示例：{sample}"

    # 情况 2：dict 但无 results 字段
    if "results" not in raw:
        keys = list(raw.keys())
        return 3, f"响应 dict 缺 'results' 字段；实际 keys: {keys}"

    results = raw["results"]
    if not isinstance(results, list):
        return 3, f"'results' 不是 list（{type(results).__name__}）"

    # 情况 3：results 为空（可能是 SearXNG 抓不到结果）
    if not results:
        return 2, f"results 为空（可能是 SearXNG 暂未抓取到结果；用更通用 query 复测）"

    # 情况 4：results 第一项缺关键字段
    sample = results[0]
    if not isinstance(sample, dict):
        return 3, f"results[0] 不是 dict（{type(sample).__name__}）"

    required_keys = {"title", "url", "content"}
    actual_keys = set(sample.keys())
    missing = required_keys - actual_keys
    if missing:
        return 3, f"results[0] 缺关键字段 {missing}；实际 keys: {actual_keys}"

    # 兼容：dict + results 是 list + 每项含 title/url/content
    score = sample.get("score", "(缺失)")
    return 0, f"兼容 Tavily 原生工具（dict['results'][i] 含 title/url/content/score={score}）"


async def main_async() -> int:
    print(f"=== SearXNG Tavily adapter spike ===\n")

    base_url = os.environ.get("AI_CHAT_WEB_SEARCH_BASE_URL", "https://search.believeboy.com")
    print(f"target base_url: {base_url}\n")

    # 第 1 轮：真实问题（中英文都试）
    queries = ["今天北京天气", "Pydantic AI", "OpenAI"]
    last_raw = None
    for q in queries:
        print(f"--- query: {q!r} ---")
        try:
            raw = await _call_tavily_client(q)
        except Exception as exc:
            print(f"FAIL: 请求异常: {type(exc).__name__}: {exc}")
            return 4
        last_raw = raw
        print(f"raw type: {type(raw).__name__}")
        if isinstance(raw, dict):
            print(f"raw keys: {list(raw.keys())}")
            if "results" in raw and isinstance(raw.get("results"), list):
                print(f"results count: {len(raw['results'])}")
                if raw["results"]:
                    print(f"results[0] keys: {list(raw['results'][0].keys())}")
                    print(f"results[0] sample: {json.dumps(raw['results'][0], ensure_ascii=False)[:300]}")
        print(f"raw (first 500 chars): {json.dumps(raw, ensure_ascii=False, default=str)[:500]}")
        print()

        code, msg = _diagnose(raw)
        if code == 0:
            print(f"\n✓ 兼容 Tavily 原生工具")
            print(f"  {msg}")
            print(f"\n=== 决策 ===")
            print(f"  → Phase 2 任务 4：用 Pydantic AI 自带 `tavily_search_tool`")
            print(f"  → mapper `_handle_tool_result` content 解析路径：list[dict]（Pydantic AI TavilySearchResult 标准格式）")
            print(f"  → 可能需要兼容 dict（若 SearXNG adapter 有时返回 dict）— 任务 3 步骤 3 加 `_normalize_tool_content`")
            return 0
        elif code == 2:
            print(f"  ⚠ {msg}（继续试下一个 query）\n")
            continue
        else:
            print(f"\n✗ 不兼容 Tavily 原生工具")
            print(f"  {msg}")
            print(f"\n=== 决策 ===")
            print(f"  → Phase 2 任务 4 走备选：写自定义 tool 函数 @agent.tool 装饰器")
            print(f"    直接 httpx POST 到 {base_url} 并按 SearXNG adapter 实际响应解析")
            print(f"  → mapper `_handle_tool_result` content 解析路径：按实际响应 shape 写")
            return code

    print(f"所有 query 都返回空 results；视为不兼容（adapter 可能限流或配置异常）")
    return 2


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    sys.exit(main())
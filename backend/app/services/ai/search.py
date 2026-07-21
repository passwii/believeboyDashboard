from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status

from app.core.config import Settings
from app.utils.constants import (
    AI_CHAT_SEARCH_SNIPPET_MAX_LENGTH,
    AI_CHAT_SEARCH_SOURCE_CARD_MAX_LENGTH,
)

from app.services.ai.chat import normalize_optional_text, trim_trailing_slash

# Phase 1.2(2026-07-21 集成计划):search 类工具名集合 + 消息级搜索元数据抽取,
# 供 V2 StreamRunner 在 agent 跑完后从 result.all_messages() 还原 source cards。
from pydantic_ai.messages import ToolCallPart, ToolReturnPart

SEARCH_TOOL_NAMES = frozenset({"tavily_search", "web_search"})


def normalize_tool_content(content: Any) -> list[dict]:
    """把 Tavily tool 返回的 content 标准化为 list[dict]。

    SearXNG adapter 走 Pydantic AI 自带 `tavily_search_tool` 时返回
    list[TavilySearchResult](每项含 title/url/content/score/raw_content)。
    兼容两种格式:list[dict](标准)/ dict 含 'results' 键(adapter 直返回)。
    """
    if isinstance(content, list):
        return [dict(r) for r in content]
    if isinstance(content, dict):
        return list(content.get("results") or [])
    return []


def extract_search_meta_from_messages(
    messages: Any,
) -> tuple[list[dict] | None, str | None, str | None]:
    """从 agent 最终消息列表抽取联网搜索元数据。

    返回 (source_cards, time_range, query);无搜索调用则 (None, None, None)。
    通过 part.tool_name 直接识别 search 工具(ToolCallPart 取 query/time_range,
    ToolReturnPart 取结果建卡片),不依赖 tool_call_id 配对。
    """
    query: str | None = None
    time_range: str | None = None
    cards: list[dict] | None = None
    for msg in messages or []:
        for part in getattr(msg, "parts", None) or []:
            if isinstance(part, ToolCallPart) and part.tool_name in SEARCH_TOOL_NAMES:
                args = part.args if isinstance(part.args, dict) else {}
                query = args.get("query") or query
                time_range = args.get("time_range") or time_range
            elif isinstance(part, ToolReturnPart) and part.tool_name in SEARCH_TOOL_NAMES:
                results = normalize_tool_content(part.content)
                if results:
                    cards = build_search_source_cards({"results": results})
    return cards, time_range, query


def is_web_search_configured(settings: Settings) -> bool:
    return bool(
        settings.ai_chat_web_search_base_url.strip()
        and settings.ai_chat_web_search_api_key.strip()
    )


def build_web_search_query(query: str) -> str:
    current_date = datetime.now().date().isoformat()
    normalized_query = query.strip()
    return (
        f"{normalized_query}\n"
        f"\u5f53\u524d\u65e5\u671f\uff1a{current_date}\u3002\n"
        "\u8bf7\u4f18\u5148\u8fd4\u56de\u6700\u8fd1\u53d1\u5e03\u3001\u6700\u8fd1\u66f4\u65b0\u3001\u65f6\u6548\u6027\u6700\u5f3a\u7684\u7ed3\u679c\uff0c\u5e76\u4f18\u5148\u8003\u8651\u6700\u65b0\u4fe1\u606f\u3002"
    ).strip()


def detect_time_range_from_query(query: str) -> str:
    query_lower = ''.join(query.lower().split())

    if any(
        kw in query_lower
        for kw in [
            "今天",
            "今日",
            "昨天",
            "昨日",
            "将近",
            "1天",
            "1日",
            "最近1天",
            "最近1日",
            "近1天",
            "近1日",
        ]
    ):
        return "day"

    if any(
        kw in query_lower
        for kw in [
            "今年",
            "年内",
            "今年内",
            "最近一年",
            "最近365天",
            "去年",
            "上年",
            "近一年",
            "近365天",
        ]
    ):
        return "year"

    if any(
        kw in query_lower
        for kw in [
            "本月",
            "这个月",
            "本月内",
            "最近一个月",
            "最近30天",
            "最近30日",
            "上个月",
            "上月",
            "近一个月",
            "近30天",
            "近30日",
            "最近",
        ]
    ):
        return "month"

    if any(
        kw in query_lower
        for kw in [
            "本周",
            "这周",
            "本周内",
            "本星期",
            "最近一周",
            "最近7天",
            "最近7日",
            "上周",
            "上星期",
            "近一周",
            "近7天",
            "近7日",
        ]
    ):
        return "week"

    return "month"


def request_web_search(settings: Settings, query: str) -> dict[str, Any]:
    if not is_web_search_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="\u8054\u7f51\u641c\u7d22\u672a\u914d\u7f6e\uff0c\u8bf7\u68c0\u67e5 backend/.env \u4e2d\u7684 AI_CHAT_WEB_SEARCH_* \u53d8\u91cf",
        )

    endpoint = (
        f"{trim_trailing_slash(settings.ai_chat_web_search_base_url.strip())}/search"
    )
    search_query = build_web_search_query(query)
    time_range = detect_time_range_from_query(query)
    payload: dict[str, Any] = {
        "query": search_query,
        "topic": settings.ai_chat_web_search_topic.strip() or "general",
        "search_depth": settings.ai_chat_web_search_depth.strip() or "advanced",
        "max_results": settings.ai_chat_web_search_max_results,
        "time_range": time_range,
        "include_answer": True,
        "include_raw_content": True,
        "include_favicon": True,
    }
    headers = {
        "Authorization": f"Bearer {settings.ai_chat_web_search_api_key.strip()}",
        "Content-Type": "application/json",
    }

    try:
        response = httpx.post(
            endpoint,
            json=payload,
            headers=headers,
            timeout=settings.ai_chat_timeout_seconds,
        )
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Web search request failed ({exc.response.status_code}): {detail[:300]}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Web search request failed: {exc}",
        ) from exc


def format_web_search_context(payload: dict[str, Any], query: str) -> str:
    answer = payload.get("answer", "")
    results = payload.get("results", [])
    lines = [
        "\u4ee5\u4e0b\u662f\u7cfb\u7edf\u521a\u521a\u6267\u884c\u7684\u8054\u7f51\u641c\u7d22\u7ed3\u679c\uff0c\u8bf7\u5c06\u5176\u4f5c\u4e3a\u8865\u5145\u4e8b\u5b9e\u4f9d\u636e\u6765\u56de\u7b54\u7528\u6237\u95ee\u9898\u3002",
        "\u8981\u6c42\uff1a\u4f18\u5148\u5f15\u7528\u53ef\u4fe1\u6765\u6e90\uff1b\u5982\u679c\u7ed3\u679c\u4e0d\u8db3\u6216\u4e92\u76f8\u51b2\u7a81\uff0c\u9700\u8981\u660e\u786e\u8bf4\u660e\uff1b\u4e0d\u8981\u628a\u672a\u51fa\u73b0\u5728\u7ed3\u679c\u91cc\u7684\u7ec6\u8282\u5f53\u6210\u5df2\u9a8c\u8bc1\u4e8b\u5b9e\u3002",
        f"\u641c\u7d22\u8bcd\uff1a{query}",
    ]

    if isinstance(answer, str) and answer.strip():
        lines.extend(["", "\u641c\u7d22\u6458\u8981\uff1a", answer.strip()])

    if isinstance(results, list) and results:
        lines.extend(["", "\u641c\u7d22\u7ed3\u679c\uff1a"])
        for index, item in enumerate(results[:8], start=1):
            if not isinstance(item, dict):
                continue

            title = normalize_optional_text(item.get("title")) or "\u672a\u547d\u540d\u7ed3\u679c"
            url = normalize_optional_text(item.get("url"))
            content = normalize_optional_text(item.get("content"))
            raw_content = normalize_optional_text(item.get("raw_content"))
            snippet = content or raw_content
            if len(snippet) > AI_CHAT_SEARCH_SNIPPET_MAX_LENGTH:
                snippet = snippet[:AI_CHAT_SEARCH_SNIPPET_MAX_LENGTH].rstrip() + "..."

            host = ""
            if url:
                parsed = urlparse(url)
                host = parsed.netloc

            lines.append(f"{index}. {title}")
            if host:
                lines.append(f"\u6765\u6e90\u57df\u540d\uff1a{host}")
            if url:
                lines.append(f"\u94fe\u63a5\uff1a{url}")
            if snippet:
                lines.append(f"\u6458\u8981\uff1a{snippet}")
            lines.append("")
    else:
        lines.extend(["", "\u641c\u7d22\u7ed3\u679c\uff1a\u672a\u8fd4\u56de\u6709\u6548\u7ed3\u679c\u3002"])

    return "\n".join(lines).strip()


def build_search_source_cards(
    payload: dict[str, Any], max_results: int | None = None
) -> list[dict[str, Any]]:
    results = payload.get("results", [])
    cards: list[dict[str, Any]] = []
    if not isinstance(results, list):
        return cards

    limit = max_results if isinstance(max_results, int) and max_results > 0 else 6

    for item in results[:limit]:
        if not isinstance(item, dict):
            continue

        title = normalize_optional_text(item.get("title")) or "\u672a\u547d\u540d\u7ed3\u679c"
        url = normalize_optional_text(item.get("url"))
        if not url:
            continue

        content = normalize_optional_text(item.get("content"))
        raw_content = normalize_optional_text(item.get("raw_content"))
        snippet = content or raw_content
        if len(snippet) > AI_CHAT_SEARCH_SOURCE_CARD_MAX_LENGTH:
            snippet = snippet[:AI_CHAT_SEARCH_SOURCE_CARD_MAX_LENGTH].rstrip() + "..."

        host = ""
        parsed = urlparse(url)
        if parsed.netloc:
            host = parsed.netloc

        score_value = item.get("score")
        # SearXNG Tavily adapter 实际以字符串（如 "0.9"）返回 score，旧
        # isinstance(int, float) 校验会把所有字符串判 False 导致卡片 score 永为 None；
        # 改为 try/except 接受 int / float / str 三种输入并解析。
        try:
            score = float(score_value) if score_value is not None else None
        except (TypeError, ValueError):
            score = None

        favicon = normalize_optional_text(item.get("favicon") or "")

        card = {
            "title": title,
            "url": url,
            "snippet": snippet,
            "domain": host,
            "score": score,
        }
        if favicon:
            card["favicon"] = favicon

        cards.append(card)

    return cards


def execute_web_search(
    query: str, time_range: str, settings: Settings
) -> dict[str, Any]:
    if not is_web_search_configured(settings):
        return {"error": "Web search not configured"}

    search_query = build_web_search_query(query)
    endpoint = (
        f"{trim_trailing_slash(settings.ai_chat_web_search_base_url.strip())}/search"
    )
    payload: dict[str, Any] = {
        "query": search_query,
        "topic": settings.ai_chat_web_search_topic.strip() or "general",
        "search_depth": settings.ai_chat_web_search_depth.strip() or "advanced",
        "max_results": settings.ai_chat_web_search_max_results,
        "time_range": time_range,
        "include_answer": True,
        "include_raw_content": True,
        "include_favicon": True,
    }
    headers = {
        "Authorization": f"Bearer {settings.ai_chat_web_search_api_key.strip()}",
        "Content-Type": "application/json",
    }

    try:
        response = httpx.post(
            endpoint,
            json=payload,
            headers=headers,
            timeout=settings.ai_chat_timeout_seconds,
        )
        response.raise_for_status()
        return response.json()
    except Exception as e:
        return {"error": str(e)}

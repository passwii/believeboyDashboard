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
    query_lower = query.lower()

    if any(
        kw in query_lower
        for kw in ["\u6628\u5929", "\u6628\u65e5", "\u5c06\u8fd1", "1\u5929", "1\u65e5", "\u6700\u8fd11\u5929", "\u6700\u8fd11\u65e5"]
    ):
        return "day"

    if any(
        kw in query_lower
        for kw in [
            "\u672c\u5468", "\u8fd9\u5468", "\u672c\u5468\u5185", "\u672c\u661f\u671f",
            "\u6700\u8fd1\u4e00\u5468", "\u6700\u8fd17\u5929", "\u6700\u8fd17\u65e5",
            "\u4e0a\u5468", "\u4e0a\u661f\u671f",
        ]
    ):
        return "week"

    if any(
        kw in query_lower
        for kw in [
            "\u672c\u6708", "\u8fd9\u4e2a\u6708", "\u672c\u6708\u5185", "\u6700\u8fd1\u4e00\u4e2a\u6708",
            "\u6700\u8fd130\u5929", "\u6700\u8fd130\u65e5", "\u4e0a\u4e2a\u6708", "\u4e0a\u6708",
        ]
    ):
        return "month"

    if any(
        kw in query_lower
        for kw in ["\u672c\u5e74", "\u4eca\u5e74", "\u5e74\u5185", "\u6700\u8fd1\u4e00\u5e74", "\u6700\u8fd1365\u5929", "\u53bb\u5e74", "\u4e0a\u5e74"]
    ):
        return "year"

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
        score = float(score_value) if isinstance(score_value, (int, float)) else None

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

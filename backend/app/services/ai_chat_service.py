from __future__ import annotations

from datetime import datetime
import json
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status
from sqlalchemy import inspect, select, sql
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.ai_chat import AIConversation, AIMessage
from app.schemas.ai_chat import LLMConfigInput

SEARCH_SNIPPET_MAX_LENGTH = 1200
SEARCH_SOURCE_CARD_MAX_LENGTH = 280

# Tool Calling: Web Search function schema
WEB_SEARCH_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": "当需要获取最新信息、实时数据、新闻或不确定的事实时，使用此工具搜索互联网。适用于：查询最新新闻、了解实时数据、验证最新信息、获取当前日期的事件等场景。",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词，用中文描述你想查询的信息。应该是简洁的核心查询词，而非完整的问题。",
                },
                "time_range": {
                    "type": "string",
                    "description": "搜索结果的时间范围",
                    "enum": ["day", "week", "month", "year"],
                    "default": "month",
                },
            },
            "required": ["query"],
        },
    },
}


def normalize_optional_text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def ensure_tables(db: Session) -> None:
    # Keep local sqlite startup simple even if migration not run yet.
    AIConversation.__table__.create(bind=db.get_bind(), checkfirst=True)
    AIMessage.__table__.create(bind=db.get_bind(), checkfirst=True)
    bind = db.get_bind()
    inspector = inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("ai_messages")}
    if "search_sources" not in columns:
        with bind.begin() as connection:
            connection.exec_driver_sql(
                "ALTER TABLE ai_messages ADD COLUMN search_sources TEXT"
            )


def list_conversations(db: Session) -> list[AIConversation]:
    stmt = select(AIConversation).order_by(AIConversation.updated_at.desc())
    return list(db.execute(stmt).scalars().all())


def create_conversation(db: Session, title: str | None) -> AIConversation:
    normalized_title = (title or "").strip() or "新对话"
    row = AIConversation(title=normalized_title)
    db.add(row)
    db.flush()
    return row


def delete_conversation(db: Session, conversation: AIConversation) -> None:
    db.delete(conversation)


def get_conversation_or_404(db: Session, conversation_id: int) -> AIConversation:
    row = db.get(AIConversation, conversation_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found"
        )
    return row


def list_messages(db: Session, conversation_id: int) -> list[AIMessage]:
    stmt = (
        select(AIMessage)
        .where(AIMessage.conversation_id == conversation_id)
        .order_by(AIMessage.created_at.asc())
    )
    return list(db.execute(stmt).scalars().all())


def append_message(
    db: Session,
    conversation_id: int,
    role: str,
    content: str,
    search_sources: list[dict[str, Any]] | None = None,
) -> AIMessage:
    row = AIMessage(
        conversation_id=conversation_id,
        role=role,
        content=content,
        search_sources=json.dumps(search_sources, ensure_ascii=False)
        if search_sources
        else None,
    )
    db.add(row)
    return row


def update_message_content(
    db: Session, message_id: int, content: str
) -> AIMessage | None:
    row = db.get(AIMessage, message_id)
    if row:
        row.content = content
    return row


def mark_message_complete(
    db: Session,
    message_id: int,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    duration_ms: int | None = None,
) -> AIMessage | None:
    row = db.get(AIMessage, message_id)
    if row:
        row.is_complete = True
        row.prompt_tokens = prompt_tokens
        row.completion_tokens = completion_tokens
        row.total_tokens = total_tokens
        row.duration_ms = duration_ms
    return row


def recalculate_conversation_token_stats(db: Session, conversation_id: int) -> None:
    stmt = select(
        sql.func.coalesce(sql.func.sum(AIMessage.prompt_tokens), 0).label("prompt"),
        sql.func.coalesce(sql.func.sum(AIMessage.completion_tokens), 0).label(
            "completion"
        ),
        sql.func.coalesce(sql.func.sum(AIMessage.total_tokens), 0).label("total"),
    ).where(AIMessage.conversation_id == conversation_id)
    result = db.execute(stmt).fetchone()
    if result:
        conversation = db.get(AIConversation, conversation_id)
        if conversation:
            conversation.total_prompt_tokens = result.prompt
            conversation.total_completion_tokens = result.completion
            conversation.total_tokens = result.total
            db.flush()


def trim_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value


def build_web_search_query(query: str) -> str:
    current_date = datetime.now().date().isoformat()
    normalized_query = query.strip()
    return (
        f"{normalized_query}\n"
        f"当前日期：{current_date}。\n"
        "请优先返回最近发布、最近更新、时效性最强的结果，并优先考虑最新信息。"
    ).strip()


def request_chat_completion(
    llm_config: LLMConfigInput,
    messages: list[dict[str, str]],
    temperature: float,
) -> dict[str, Any]:
    endpoint = f"{llm_config.base_url.rstrip('/')}/chat/completions"
    payload: dict[str, Any] = {
        "model": llm_config.model,
        "messages": messages,
        "temperature": temperature,
    }
    if llm_config.reasoning_effort:
        payload["reasoning"] = {"effort": llm_config.reasoning_effort}
    headers = {
        "Authorization": f"Bearer {llm_config.api_key}",
        "Content-Type": "application/json",
    }

    try:
        with httpx.Client(timeout=llm_config.timeout_seconds) as client:
            response = client.post(endpoint, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"LLM request failed ({exc.response.status_code}): {detail[:300]}",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=f"LLM request failed: {exc}"
        ) from exc


def get_first_choice(data: dict[str, Any]) -> dict[str, Any]:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return {}
    first = choices[0]
    return first if isinstance(first, dict) else {}


def is_web_search_configured(settings: Settings) -> bool:
    return bool(
        settings.ai_chat_web_search_base_url.strip()
        and settings.ai_chat_web_search_api_key.strip()
    )


def detect_time_range_from_query(query: str) -> str:
    query_lower = query.lower()

    if any(
        kw in query_lower
        for kw in ["昨天", "昨天", "昨日", "昨天", "1天", "1日", "最近1天", "最近1日"]
    ):
        return "day"

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
        ]
    ):
        return "week"

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
        ]
    ):
        return "month"

    if any(
        kw in query_lower
        for kw in ["本年", "今年", "年内", "最近一年", "最近365天", "去年", "上年"]
    ):
        return "year"

    return "month"


def request_web_search(settings: Settings, query: str) -> dict[str, Any]:
    if not is_web_search_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="联网搜索未配置，请检查 backend/.env 中的 AI_CHAT_WEB_SEARCH_* 变量",
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
        "以下是系统刚刚执行的联网搜索结果，请将其作为补充事实依据来回答用户问题。",
        "要求：优先引用可信来源；如果结果不足或互相冲突，需要明确说明；不要把未出现在结果里的细节当成已验证事实。",
        f"搜索词：{query}",
    ]

    if isinstance(answer, str) and answer.strip():
        lines.extend(["", "搜索摘要：", answer.strip()])

    if isinstance(results, list) and results:
        lines.extend(["", "搜索结果："])
        for index, item in enumerate(results[:8], start=1):
            if not isinstance(item, dict):
                continue

            title = normalize_optional_text(item.get("title")) or "未命名结果"
            url = normalize_optional_text(item.get("url"))
            content = normalize_optional_text(item.get("content"))
            raw_content = normalize_optional_text(item.get("raw_content"))
            snippet = content or raw_content
            if len(snippet) > SEARCH_SNIPPET_MAX_LENGTH:
                snippet = snippet[:SEARCH_SNIPPET_MAX_LENGTH].rstrip() + "..."

            host = ""
            if url:
                parsed = urlparse(url)
                host = parsed.netloc

            lines.append(f"{index}. {title}")
            if host:
                lines.append(f"来源域名：{host}")
            if url:
                lines.append(f"链接：{url}")
            if snippet:
                lines.append(f"摘要：{snippet}")
            lines.append("")
    else:
        lines.extend(["", "搜索结果：未返回有效结果。"])

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

        title = normalize_optional_text(item.get("title")) or "未命名结果"
        url = normalize_optional_text(item.get("url"))
        if not url:
            continue

        content = normalize_optional_text(item.get("content"))
        raw_content = normalize_optional_text(item.get("raw_content"))
        snippet = content or raw_content
        if len(snippet) > SEARCH_SOURCE_CARD_MAX_LENGTH:
            snippet = snippet[:SEARCH_SOURCE_CARD_MAX_LENGTH].rstrip() + "..."

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


def parse_search_sources(value: str | None) -> list[dict[str, Any]]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def merge_stream_tool_calls(
    existing_calls: list[dict[str, Any]], delta_calls: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Merge streamed tool_call deltas into complete tool call objects."""
    merged = [dict(item) for item in existing_calls]

    for delta in delta_calls:
        if not isinstance(delta, dict):
            continue

        index_value = delta.get("index")
        if not isinstance(index_value, int) or index_value < 0:
            index_value = len(merged)

        while len(merged) <= index_value:
            merged.append({"id": "", "type": "function", "function": {}})

        current = merged[index_value]
        if not isinstance(current, dict):
            current = {"id": "", "type": "function", "function": {}}
            merged[index_value] = current

        tool_id = delta.get("id")
        if isinstance(tool_id, str) and tool_id:
            current["id"] = tool_id

        tool_type = delta.get("type")
        if isinstance(tool_type, str) and tool_type:
            current["type"] = tool_type

        function_delta = delta.get("function")
        current_function = current.get("function")
        if not isinstance(current_function, dict):
            current_function = {}
            current["function"] = current_function

        if isinstance(function_delta, dict):
            function_name = function_delta.get("name")
            if isinstance(function_name, str) and function_name:
                current_function["name"] = (
                    f"{current_function.get('name', '')}{function_name}"
                )

            function_arguments = function_delta.get("arguments")
            if isinstance(function_arguments, str) and function_arguments:
                current_function["arguments"] = (
                    f"{current_function.get('arguments', '')}{function_arguments}"
                )

    return merged


def stream_with_tool_calling(
    llm_config: LLMConfigInput,
    messages: list[dict[str, Any]],
    settings: Settings,
    temperature: float = 0.7,
    max_tool_calls: int = 3,
):
    """Tool calling 流式处理主循环"""
    tools = [WEB_SEARCH_TOOL_SCHEMA]
    all_messages = list(messages)
    search_source_cards: list[dict[str, Any]] = []
    tool_call_count = 0

    while tool_call_count < max_tool_calls:
        payload = {
            "model": llm_config.model,
            "messages": all_messages,
            "temperature": temperature,
            "stream": True,
            "tools": tools,
        }
        if llm_config.reasoning_effort:
            payload["reasoning"] = {"effort": llm_config.reasoning_effort}

        endpoint = f"{llm_config.base_url.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {llm_config.api_key}",
            "Content-Type": "application/json",
        }

        content_buffer = ""
        current_tool_calls: list[dict[str, Any]] = []

        try:
            with httpx.Client(timeout=llm_config.timeout_seconds) as client:
                with client.stream(
                    "POST", endpoint, json=payload, headers=headers
                ) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if not line:
                            continue
                        text = (
                            line
                            if isinstance(line, str)
                            else line.decode("utf-8", errors="ignore")
                        )
                        if not text.startswith("data:"):
                            continue
                        payload_text = text[5:].strip()
                        if not payload_text or payload_text == "[DONE]":
                            if payload_text == "[DONE]":
                                break
                            continue
                        try:
                            data = json.loads(payload_text)
                        except json.JSONDecodeError:
                            continue

                        choice = get_first_choice(data)
                        delta = choice.get("delta", {})
                        if not isinstance(delta, dict):
                            delta = {}

                        chunk = delta.get("content", "")
                        if chunk:
                            content_buffer += chunk
                            yield {"type": "chunk", "delta": chunk}

                        usage = data.get("usage")
                        if usage:
                            yield {"type": "usage", "usage": usage}

                        tool_calls = delta.get("tool_calls", [])
                        if tool_calls:
                            current_tool_calls = merge_stream_tool_calls(
                                current_tool_calls, tool_calls
                            )

                        finish_reason = choice.get("finish_reason", "")

                        if finish_reason == "tool_calls" or (
                            finish_reason and not content_buffer
                        ):
                            break
        except httpx.HTTPStatusError as exc:
            yield {
                "type": "error",
                "message": f"LLM request failed ({exc.response.status_code})",
            }
            return
        except httpx.HTTPError as exc:
            yield {"type": "error", "message": f"LLM request failed: {exc}"}
            return

        if not current_tool_calls:
            break

        tool_call_count += 1
        yield {"type": "tool_calls", "tool_calls": current_tool_calls}

        for tool_call in current_tool_calls:
            tool_name = extract_tool_function_name(tool_call)
            tool_args = extract_tool_function_arguments(tool_call)
            tool_id = extract_tool_call_id(tool_call)

            if tool_name == "web_search":
                yield {
                    "type": "tool_searching",
                    "tool_name": "web_search",
                    "query": tool_args.get("query", ""),
                }

                search_result = execute_web_search(
                    tool_args.get("query", ""),
                    tool_args.get("time_range", "month"),
                    settings,
                )

                yield {
                    "type": "tool_done",
                    "tool_name": "web_search",
                    "success": "error" not in search_result,
                }

                if "error" not in search_result:
                    search_source_cards = build_search_source_cards(
                        search_result, settings.ai_chat_web_search_max_results
                    )
                    if search_source_cards:
                        yield {"type": "sources", "sources": search_source_cards}
                    search_context = format_web_search_context(
                        search_result, tool_args.get("query", "")
                    )
                    tool_result_message = {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": search_context,
                    }
                else:
                    tool_result_message = {
                        "role": "tool",
                        "tool_call_id": tool_id,
                        "content": f"搜索失败: {search_result.get('error')}",
                    }
            else:
                tool_result_message = {
                    "role": "tool",
                    "tool_call_id": tool_id,
                    "content": f"未知工具: {tool_name}",
                }

            all_messages.append({"role": "assistant", "tool_calls": [tool_call]})
            all_messages.append(tool_result_message)


# Status codes that are worth retrying with automatic fallback
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
RETRY_WAIT_SECONDS = 30
MAX_RETRIES = 2


def _stream_with_retries(
    llm_config: LLMConfigInput,
    messages: list[dict[str, Any]],
    temperature: float,
    settings: Settings,
) -> tuple[list[dict[str, Any]], str | None]:
    """
    Stream LLM completion with automatic retries (30s wait, up to 2 retries).
    On exhaustion, falls back to AI_CHAT_BACKUP_MODEL if configured.
    Returns (chunks, error_message). error_message=None means success.
    """
    import time as _time

    backup = settings.ai_chat_backup_model.strip()
    models_to_try = [llm_config.model]
    if backup and backup != llm_config.model:
        models_to_try.append(backup)

    for attempt_idx, model_name in enumerate(models_to_try):
        is_backup_model = attempt_idx > 0
        for retry_count in range(MAX_RETRIES + 1):
            chunks_collected: list[dict[str, Any]] = []
            is_final_attempt = (
                is_backup_model and retry_count == MAX_RETRIES
            )

            try:
                endpoint = f"{llm_config.base_url.rstrip('/')}/chat/completions"
                payload: dict[str, Any] = {
                    "model": model_name,
                    "messages": messages,
                    "temperature": temperature,
                    "stream": True,
                }
                if llm_config.reasoning_effort:
                    payload["reasoning"] = {"effort": llm_config.reasoning_effort}
                headers = {
                    "Authorization": f"Bearer {llm_config.api_key}",
                    "Content-Type": "application/json",
                }

                with httpx.Client(timeout=llm_config.timeout_seconds) as client:
                    with client.stream(
                        "POST", endpoint, json=payload, headers=headers
                    ) as response:
                        # Check pre-stream retryable status
                        if response.status_code in RETRYABLE_STATUS_CODES:
                            if not is_final_attempt:
                                retry_after = RETRY_WAIT_SECONDS
                                ra = response.headers.get("retry-after", "")
                                if ra:
                                    try:
                                        retry_after = max(1, int(ra))
                                    except ValueError:
                                        pass
                                _time.sleep(retry_after)
                                continue
                            # Final attempt: raise to trigger error handling below
                            response.raise_for_status()

                        response.raise_for_status()
                        for line in response.iter_lines():
                            if not line:
                                continue
                            text = (
                                line
                                if isinstance(line, str)
                                else line.decode("utf-8", errors="ignore")
                            )
                            if not text.startswith("data:"):
                                continue
                            payload_text = text[5:].strip()
                            if not payload_text or payload_text == "[DONE]":
                                if payload_text == "[DONE]":
                                    break
                                continue
                            try:
                                data = json.loads(payload_text)
                            except json.JSONDecodeError:
                                continue
                            choices = data.get("choices", [])
                            if not isinstance(choices, list) or not choices:
                                continue
                            first_choice = choices[0] if isinstance(choices[0], dict) else {}
                            delta = (
                                first_choice.get("delta", {})
                                if isinstance(first_choice, dict)
                                else {}
                            )
                            if not isinstance(delta, dict):
                                continue
                            thinking = delta.get("thinking", "")
                            if isinstance(thinking, str) and thinking:
                                chunks_collected.append({"type": "thinking", "content": thinking})
                            content_chunk = delta.get("content", "")
                            if isinstance(content_chunk, str) and content_chunk:
                                chunks_collected.append({"type": "content", "content": content_chunk})
                            usage = data.get("usage")
                            if usage:
                                chunks_collected.append({"type": "usage", "usage": usage})

                # Success — return all collected chunks
                return chunks_collected, None

            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in RETRYABLE_STATUS_CODES and not is_final_attempt:
                    retry_after = RETRY_WAIT_SECONDS
                    ra = exc.response.headers.get("retry-after", "")
                    if ra:
                        try:
                            retry_after = max(1, int(ra))
                        except ValueError:
                            pass
                    _time.sleep(retry_after)
                    continue

                # Non-retryable or exhausted retries — try next model if available
                detail = exc.response.text[:200]
                if attempt_idx < len(models_to_try) - 1:
                    # Not the last model — switch to it
                    continue
                return chunks_collected, (
                    f"LLM request failed ({exc.response.status_code}): {detail}"
                )

            except httpx.TimeoutException as exc:
                if not is_final_attempt:
                    _time.sleep(RETRY_WAIT_SECONDS)
                    continue
                if attempt_idx < len(models_to_try) - 1:
                    continue
                return chunks_collected, f"LLM request timed out: {exc}"

            except httpx.HTTPError as exc:
                if not is_final_attempt:
                    _time.sleep(RETRY_WAIT_SECONDS)
                    continue
                if attempt_idx < len(models_to_try) - 1:
                    continue
                return chunks_collected, f"LLM request failed: {exc}"

    # Should not reach here
    return [], "Unexpected error in retry loop"


def iter_chat_completion_stream(
    llm_config: LLMConfigInput,
    messages: list[dict[str, Any]],
    temperature: float,
    settings: Settings,
):
    chunks, error_message = _stream_with_retries(llm_config, messages, temperature, settings)
    for chunk in chunks:
        yield chunk
    if error_message:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=error_message,
        )



def parse_tool_calls(data: dict[str, Any]) -> list[dict[str, Any]]:
    """从 LLM 响应中解析 tool_calls"""
    message = get_first_choice(data).get("message", {})
    tool_calls = message.get("tool_calls", [])
    if not tool_calls:
        return []
    return tool_calls if isinstance(tool_calls, list) else []


def extract_tool_call_id(tool_call: dict[str, Any]) -> str:
    return tool_call.get("id", "")


def extract_tool_function_name(tool_call: dict[str, Any]) -> str:
    function = tool_call.get("function", {})
    return function.get("name", "") if isinstance(function, dict) else ""


def extract_tool_function_arguments(tool_call: dict[str, Any]) -> dict[str, Any]:
    function = tool_call.get("function", {})
    if not isinstance(function, dict):
        return {}
    args_str = function.get("arguments", "{}")
    try:
        return json.loads(args_str) if isinstance(args_str, str) else args_str
    except json.JSONDecodeError:
        return {}


def execute_tool_call(
    tool_name: str, arguments: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    """执行 tool 调用"""
    if tool_name == "web_search":
        query = arguments.get("query", "")
        time_range = arguments.get("time_range", "month")
        return execute_web_search(query, time_range, settings)
    else:
        return {"error": f"Unknown tool: {tool_name}"}


def execute_web_search(
    query: str, time_range: str, settings: Settings
) -> dict[str, Any]:
    """执行 web search"""
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


def extract_message_content(data: dict[str, Any]) -> str:
    content = get_first_choice(data).get("message", {}).get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="LLM returned empty content"
        )
    return content.strip()


def get_blocked_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_model_blocklist.split(",")]
    return {item for item in models if item}


def get_premium_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_premium_models.split(",")]
    return {item for item in models if item}


def get_basic_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_basic_models.split(",")]
    return {item for item in models if item}


def get_reasoning_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_reasoning_models.split(",")]
    return {item for item in models if item}


def normalize_reasoning_effort(value: str | None) -> str | None:
    effort = (value or "").strip().lower()
    if effort in {"low", "medium", "high"}:
        return effort
    return None


def is_provider_configured(settings: Settings) -> bool:
    return bool(
        settings.ai_chat_provider_base_url.strip()
        and settings.ai_chat_provider_api_key.strip()
    )


def fetch_models_from_provider(
    base_url: str, api_key: str, timeout_seconds: int
) -> list[str]:
    response = httpx.get(
        f"{trim_trailing_slash(base_url)}/models",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    models = payload.get("data", []) if isinstance(payload, dict) else []
    items = []
    for item in models:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id", "")).strip()
        if model_id:
            items.append(model_id)
    return list(dict.fromkeys(items))


def resolve_available_models(settings: Settings) -> tuple[list[str], str]:
    blocklist = get_blocked_models(settings)
    default_model = settings.ai_chat_default_model.strip()

    models: list[str] = []
    if not is_provider_configured(settings):
        models = [default_model] if default_model else []
        resolved_default = default_model or (models[0] if models else "")
        return models, resolved_default

    try:
        models = fetch_models_from_provider(
            settings.ai_chat_provider_base_url.strip(),
            settings.ai_chat_provider_api_key.strip(),
            settings.ai_chat_timeout_seconds,
        )
    except httpx.HTTPError:
        models = []

    if not models and default_model:
        models = [default_model]

    unique_models = list(dict.fromkeys(models))
    filtered_models = [m for m in unique_models if m not in blocklist]
    if not filtered_models and default_model and default_model not in blocklist:
        filtered_models = [default_model]
    resolved_default = (
        default_model
        if default_model in filtered_models
        else (filtered_models[0] if filtered_models else default_model)
    )
    return filtered_models, resolved_default


def build_llm_config(
    settings: Settings,
    model: str | None,
    system_prompt: str | None,
    reasoning_effort: str | None = None,
) -> LLMConfigInput:
    if not is_provider_configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="后端 AI Provider 未配置，请检查 backend/.env",
        )

    models, default_model = resolve_available_models(settings)
    selected_model = (model or "").strip() or default_model
    if not selected_model:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="没有可用模型，请检查 backend/.env 中的 AI_CHAT_DEFAULT_MODEL",
        )

    if models and selected_model not in models:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="所选模型不在允许列表中"
        )

    supported_reasoning_models = get_reasoning_models(settings)
    normalized_reasoning_effort = normalize_reasoning_effort(reasoning_effort)
    if normalized_reasoning_effort and selected_model not in supported_reasoning_models:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前模型不支持思考强度设置",
        )

    return LLMConfigInput(
        base_url=trim_trailing_slash(settings.ai_chat_provider_base_url.strip()),
        api_key=settings.ai_chat_provider_api_key.strip(),
        model=selected_model,
        timeout_seconds=settings.ai_chat_timeout_seconds,
        system_prompt=(system_prompt or "").strip(),
        reasoning_effort=normalized_reasoning_effort,
    )


def build_payload_messages(
    messages: list[AIMessage],
    user_content: str,
    system_prompt: str,
    enable_tools: bool = False,
) -> list[dict[str, Any]]:
    payload_messages: list[dict[str, Any]] = []
    if system_prompt.strip():
        payload_messages.append({"role": "system", "content": system_prompt.strip()})

    for item in messages[-20:]:
        payload_messages.append({"role": item.role, "content": item.content})

    payload_messages.append({"role": "user", "content": user_content})
    return payload_messages


def build_payload_messages_with_tools(
    messages: list[AIMessage],
    user_content: str,
    system_prompt: str,
    web_search_context: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    payload_messages = build_payload_messages(
        messages, user_content, system_prompt, enable_tools=False
    )

    tools = [WEB_SEARCH_TOOL_SCHEMA]

    if web_search_context and web_search_context.strip():
        payload_messages = payload_messages[:-1] + [
            {"role": "system", "content": web_search_context.strip()},
            payload_messages[-1],
        ]

    return payload_messages, tools


def build_payload_messages_with_search(
    messages: list[AIMessage],
    user_content: str,
    system_prompt: str,
    web_search_context: str | None = None,
) -> list[dict[str, Any]]:
    """Backward-compatible helper for plain web-search augmented prompts."""
    payload_messages = build_payload_messages(messages, user_content, system_prompt)

    if web_search_context and web_search_context.strip():
        payload_messages = payload_messages[:-1] + [
            {"role": "system", "content": web_search_context.strip()},
            payload_messages[-1],
        ]

    return payload_messages


def resolve_title_model(settings: Settings) -> str:
    title_model = settings.ai_chat_title_model.strip()
    if title_model:
        return title_model

    default_model = settings.ai_chat_default_model.strip()
    if default_model:
        return default_model

    allowed_models, _ = resolve_available_models(settings)
    return allowed_models[0] if allowed_models else ""


def normalize_generated_title(value: str) -> str:
    text = value.strip()
    if not text:
        return ""

    first_line = next((line.strip() for line in text.splitlines() if line.strip()), "")
    normalized = first_line.strip(" \"'`“”‘’")
    for prefix in ("标题：", "标题:", "会话标题：", "会话标题:"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix) :].strip(" \"'`“”‘’")
            break

    return normalized[:40].strip()


def generate_conversation_title(
    settings: Settings, user_content: str, assistant_content: str
) -> str | None:
    import logging

    logger = logging.getLogger(__name__)

    if not is_provider_configured(settings):
        logger.warning("generate_conversation_title: AI provider not configured")
        return None

    model = resolve_title_model(settings)
    if not model:
        logger.warning("generate_conversation_title: could not resolve title model")
        return None

    if not user_content.strip() or not assistant_content.strip():
        logger.warning("generate_conversation_title: empty user or assistant content")
        return None

    llm_config = LLMConfigInput(
        base_url=trim_trailing_slash(settings.ai_chat_provider_base_url.strip()),
        api_key=settings.ai_chat_provider_api_key.strip(),
        model=model,
        timeout_seconds=settings.ai_chat_timeout_seconds,
        system_prompt="",
    )
    payload_messages = [
        {
            "role": "system",
            "content": (
                "你负责为聊天会话生成标题。"
                "请根据用户问题和助手回答，输出一个简短中文标题。"
                "要求：只输出标题本身；不加引号、句号、解释；控制在18个中文字符以内。"
            ),
        },
        {
            "role": "user",
            "content": f"用户消息：{user_content.strip()}\n\n助手回复：{assistant_content.strip()}",
        },
    ]

    try:
        data = request_chat_completion(llm_config, payload_messages, temperature=0.2)
    except HTTPException as exc:
        logger.warning(
            f"generate_conversation_title: request_chat_completion failed: {exc.detail}"
        )
        return None

    result = normalize_generated_title(extract_message_content(data))
    if not result:
        logger.warning(
            "generate_conversation_title: normalize_generated_title returned empty"
        )
    return result


def regenerate_conversation_title(
    settings: Settings, messages: list[AIMessage]
) -> str | None:
    import logging

    logger = logging.getLogger(__name__)

    if not messages:
        logger.warning("regenerate_conversation_title: no messages provided")
        return None

    if not is_provider_configured(settings):
        logger.warning("regenerate_conversation_title: AI provider not configured")
        return None

    model = resolve_title_model(settings)
    if not model:
        logger.warning("regenerate_conversation_title: could not resolve title model")
        return None

    llm_config = LLMConfigInput(
        base_url=trim_trailing_slash(settings.ai_chat_provider_base_url.strip()),
        api_key=settings.ai_chat_provider_api_key.strip(),
        model=model,
        timeout_seconds=settings.ai_chat_timeout_seconds,
        system_prompt="",
    )

    transcript_parts: list[str] = []
    for item in messages[-8:]:
        role = "用户" if item.role == "user" else "助手"
        content = item.content.strip()
        if not content:
            continue
        transcript_parts.append(f"{role}：{content[:400]}")

    if not transcript_parts:
        logger.warning(
            f"regenerate_conversation_title: no valid transcript parts from {len(messages)} messages"
        )
        return None

    payload_messages = [
        {
            "role": "system",
            "content": (
                "你负责为聊天会话生成标题。"
                "请根据整段对话内容，输出一个简短中文标题。"
                "要求：只输出标题本身；不加引号、句号、解释；控制在18个中文字符以内。"
            ),
        },
        {
            "role": "user",
            "content": "请基于下面的对话记录生成标题：\n\n"
            + "\n\n".join(transcript_parts),
        },
    ]

    try:
        data = request_chat_completion(llm_config, payload_messages, temperature=0.2)
    except HTTPException as exc:
        logger.warning(
            f"regenerate_conversation_title: request_chat_completion failed: {exc.detail}"
        )
        return None

    result = normalize_generated_title(extract_message_content(data))
    if not result:
        logger.warning(
            "regenerate_conversation_title: normalize_generated_title returned empty"
        )
    return result


def generate_assistant_content(
    llm_config: LLMConfigInput,
    messages: list[AIMessage],
    user_content: str,
    web_search_context: str | None = None,
) -> str:
    payload_messages = build_payload_messages(
        messages, user_content, llm_config.system_prompt
    )
    if web_search_context and web_search_context.strip():
        payload_messages = payload_messages[:-1] + [
            {"role": "system", "content": web_search_context.strip()},
            payload_messages[-1],
        ]
    data = request_chat_completion(llm_config, payload_messages, temperature=0.7)
    return extract_message_content(data)


def stream_assistant_content(
    llm_config: LLMConfigInput,
    messages: list[AIMessage],
    user_content: str,
    web_search_context: str | None = None,
    settings: Settings | None = None,
):
    payload_messages = build_payload_messages(
        messages, user_content, llm_config.system_prompt
    )
    if web_search_context and web_search_context.strip():
        payload_messages = payload_messages[:-1] + [
            {"role": "system", "content": web_search_context.strip()},
            payload_messages[-1],
        ]

    # Pass settings for retry / backup model support
    kwargs = {}
    if settings is not None:
        kwargs["settings"] = settings

    for item in iter_chat_completion_stream(
        llm_config, payload_messages, temperature=0.7, **kwargs
    ):
        if isinstance(item, dict):
            if item.get("type") == "thinking":
                yield {"type": "thinking", "content": item.get("content", "")}
            elif item.get("type") == "content":
                yield item.get("content", "")
            elif item.get("type") == "usage":
                pass
        elif isinstance(item, str):
            yield item

from __future__ import annotations

from datetime import datetime
import json
import logging
import threading
from typing import Any, Iterator, Optional

import httpx
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.ai_chat import AIMessage
from app.schemas.ai_chat import LLMConfigInput
from app.utils.constants import AI_CHAT_MAX_RETRIES

from app.services.ai.chat import normalize_generated_title, trim_trailing_slash


# Status codes that are worth retrying with automatic fallback
RETRYABLE_STATUS_CODES = frozenset({429, 500, 502, 503, 504})
RETRY_WAIT_SECONDS = 30


def _cancelled(cancel_event: Optional[threading.Event]) -> bool:
    return cancel_event is not None and cancel_event.is_set()


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


def extract_message_content(data: dict[str, Any]) -> str:
    content = get_first_choice(data).get("message", {}).get("content", "")
    if not isinstance(content, str) or not content.strip():
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="LLM returned empty content"
        )
    return content.strip()


def _stream_with_retries(
    llm_config: LLMConfigInput,
    messages: list[dict[str, Any]],
    temperature: float,
    settings: Settings,
    cancel_event: Optional[threading.Event] = None,
) -> Iterator[dict[str, Any]]:
    import time as _time

    backup = settings.ai_chat_backup_model.strip()
    models_to_try = [llm_config.model]
    if backup and backup != llm_config.model:
        models_to_try.append(backup)

    for attempt_idx, model_name in enumerate(models_to_try):
        is_backup_model = attempt_idx > 0
        for retry_count in range(AI_CHAT_MAX_RETRIES + 1):
            has_streamed_output = False
            is_final_attempt = (
                is_backup_model and retry_count == AI_CHAT_MAX_RETRIES
            )

            if _cancelled(cancel_event):
                return

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
                            response.raise_for_status()

                        response.raise_for_status()
                        for line in response.iter_lines():
                            # 中途取消：跳出循环后 `with httpx.Client` 退出，
                            # 强制关闭 LLM 连接，避免继续扣 token。
                            if _cancelled(cancel_event):
                                return
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
                                has_streamed_output = True
                                yield {"type": "thinking", "content": thinking}
                            content_chunk = delta.get("content", "")
                            if isinstance(content_chunk, str) and content_chunk:
                                has_streamed_output = True
                                yield {"type": "content", "content": content_chunk}
                            usage = data.get("usage")
                            if usage:
                                yield {"type": "usage", "usage": usage}

                return

            except httpx.HTTPStatusError as exc:
                if (
                    exc.response.status_code in RETRYABLE_STATUS_CODES
                    and not is_final_attempt
                    and not has_streamed_output
                ):
                    retry_after = RETRY_WAIT_SECONDS
                    ra = exc.response.headers.get("retry-after", "")
                    if ra:
                        try:
                            retry_after = max(1, int(ra))
                        except ValueError:
                            pass
                    _time.sleep(retry_after)
                    continue

                exc.response.read()
                detail = exc.response.text[:200]
                if attempt_idx < len(models_to_try) - 1 and not has_streamed_output:
                    continue
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"LLM request failed ({exc.response.status_code}): {detail}",
                ) from exc

            except httpx.TimeoutException as exc:
                if not is_final_attempt and not has_streamed_output:
                    _time.sleep(RETRY_WAIT_SECONDS)
                    continue
                if attempt_idx < len(models_to_try) - 1 and not has_streamed_output:
                    continue
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"LLM request timed out: {exc}",
                ) from exc

            except httpx.HTTPError as exc:
                if not is_final_attempt and not has_streamed_output:
                    _time.sleep(RETRY_WAIT_SECONDS)
                    continue
                if attempt_idx < len(models_to_try) - 1 and not has_streamed_output:
                    continue
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"LLM request failed: {exc}",
                ) from exc

    raise HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Unexpected error in retry loop",
    )


def iter_chat_completion_stream(
    llm_config: LLMConfigInput,
    messages: list[dict[str, Any]],
    temperature: float,
    settings: Settings,
    cancel_event: Optional[threading.Event] = None,
):
    yield from _stream_with_retries(llm_config, messages, temperature, settings, cancel_event=cancel_event)


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
    from app.services.ai.models import get_blocked_models, is_provider_configured

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
    from app.services.ai.models import get_reasoning_models, is_provider_configured, normalize_reasoning_effort

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
    from app.services.ai.tools import WEB_SEARCH_TOOL_SCHEMA

    payload_messages = build_payload_messages(
        messages, user_content, system_prompt
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
    payload_messages = build_payload_messages(messages, user_content, system_prompt)

    if web_search_context and web_search_context.strip():
        payload_messages = payload_messages[:-1] + [
            {"role": "system", "content": web_search_context.strip()},
            payload_messages[-1],
        ]

    return payload_messages


def resolve_title_model(settings: Settings) -> str:
    """为标题生成选用模型。

    策略：直接复用动态解析的可用模型列表，选第一个。
    避免硬写 ai_chat_title_model 导致模型变动维护成本。
    （若 provider 未配置，返回空字符串；由调用方处理）
    """
    allowed_models, _ = resolve_available_models(settings)
    return allowed_models[0] if allowed_models else ""


def generate_conversation_title(
    settings: Settings, user_content: str, assistant_content: str
) -> str | None:
    logger = logging.getLogger(__name__)

    from app.services.ai.models import is_provider_configured

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
    logger = logging.getLogger(__name__)

    from app.services.ai.models import is_provider_configured

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
    cancel_event: Optional[threading.Event] = None,
):
    payload_messages = build_payload_messages(
        messages, user_content, llm_config.system_prompt
    )
    if web_search_context and web_search_context.strip():
        payload_messages = payload_messages[:-1] + [
            {"role": "system", "content": web_search_context.strip()},
            payload_messages[-1],
        ]

    kwargs = {}
    if settings is not None:
        kwargs["settings"] = settings

    for item in iter_chat_completion_stream(
        llm_config, payload_messages, temperature=0.7, cancel_event=cancel_event, **kwargs
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

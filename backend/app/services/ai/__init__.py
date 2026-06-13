"""
AI Chat Service subpackage.

Split from ai_chat_service.py (legacy) into domain-specific modules.
"""

from __future__ import annotations

from app.models.ai_chat import AIConversation, AIMessage

from app.services.ai.chat import (
    append_message,
    create_conversation,
    delete_conversation,
    delete_message,
    ensure_tables,
    get_conversation_or_404,
    get_message_or_404,
    list_conversations,
    list_messages,
    mark_message_complete,
    normalize_generated_title,
    normalize_optional_text,
    parse_search_sources,
    recalculate_conversation_token_stats,
    trim_trailing_slash,
    update_message_content,
)
from app.services.ai.llm import (
    RETRYABLE_STATUS_CODES,
    RETRY_WAIT_SECONDS,
    _stream_with_retries,
    build_llm_config,
    build_payload_messages,
    build_payload_messages_with_search,
    build_payload_messages_with_tools,
    extract_message_content,
    fetch_models_from_provider,
    generate_assistant_content,
    generate_conversation_title,
    get_first_choice,
    iter_chat_completion_stream,
    regenerate_conversation_title,
    request_chat_completion,
    resolve_available_models,
    resolve_title_model,
    stream_assistant_content,
)
from app.services.ai.models import (
    get_basic_models,
    get_blocked_models,
    get_premium_models,
    get_reasoning_models,
    is_provider_configured,
    normalize_reasoning_effort,
)
from app.services.ai.search import (
    build_search_source_cards,
    build_web_search_query,
    detect_time_range_from_query,
    execute_web_search,
    format_web_search_context,
    is_web_search_configured,
    request_web_search,
)
from app.services.ai.tools import (
    WEB_SEARCH_TOOL_SCHEMA,
    execute_tool_call,
    extract_tool_call_id,
    extract_tool_function_arguments,
    extract_tool_function_name,
    merge_stream_tool_calls,
    parse_tool_calls,
    stream_with_tool_calling,
)

__all__ = [
    # Re-exported model classes (for stream_utils.py compat)
    "AIConversation",
    "AIMessage",
    # chat.py
    "append_message",
    "create_conversation",
    "delete_conversation",
    "delete_message",
    "ensure_tables",
    "get_conversation_or_404",
    "get_message_or_404",
    "list_conversations",
    "list_messages",
    "mark_message_complete",
    "normalize_generated_title",
    "normalize_optional_text",
    "parse_search_sources",
    "recalculate_conversation_token_stats",
    "trim_trailing_slash",
    "update_message_content",
    # llm.py
    "RETRYABLE_STATUS_CODES",
    "RETRY_WAIT_SECONDS",
    "_stream_with_retries",
    "build_llm_config",
    "build_payload_messages",
    "build_payload_messages_with_search",
    "build_payload_messages_with_tools",
    "extract_message_content",
    "fetch_models_from_provider",
    "generate_assistant_content",
    "generate_conversation_title",
    "get_first_choice",
    "iter_chat_completion_stream",
    "regenerate_conversation_title",
    "request_chat_completion",
    "resolve_available_models",
    "resolve_title_model",
    "stream_assistant_content",
    # models.py
    "get_basic_models",
    "get_blocked_models",
    "get_premium_models",
    "get_reasoning_models",
    "is_provider_configured",
    "normalize_reasoning_effort",
    # search.py
    "build_search_source_cards",
    "build_web_search_query",
    "detect_time_range_from_query",
    "execute_web_search",
    "format_web_search_context",
    "is_web_search_configured",
    "request_web_search",
    # tools.py
    "WEB_SEARCH_TOOL_SCHEMA",
    "execute_tool_call",
    "extract_tool_call_id",
    "extract_tool_function_arguments",
    "extract_tool_function_name",
    "merge_stream_tool_calls",
    "parse_tool_calls",
    "stream_with_tool_calling",
]

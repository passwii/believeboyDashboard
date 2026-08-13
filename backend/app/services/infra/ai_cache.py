"""AI 域（L2 长 TTL 省 token 层）缓存注册（BLF-665 子 #4）。

设计 §4.3：``ai_chat_v2``（防 stale prompt）+ ``ai_insight``（防重复计费）
两个 L2 域，4h 长 TTL + 写即失效。当前 AI 内容存储在 DB（chat messages /
insight content），尚无 Redis 缓存层；注册 invalidate_fn 使装饰器契约成立，
未来接缓存层（v1.1 re-warm）时写路径自动失效。
"""

from __future__ import annotations

from app.services.infra.cache import cache_delete_pattern
from app.services.infra.cache_decorator import register_invalidate_fn
from app.services.infra.redis import _p

AI_CHAT_V2_KEY_PREFIX = _p("cache:ai-chat-v2")
AI_INSIGHT_KEY_PREFIX = _p("cache:ai-insight")


def invalidate_ai_chat_v2_cache(project_id: int | None = None) -> int:
    return cache_delete_pattern(f"{AI_CHAT_V2_KEY_PREFIX}:*")


def invalidate_ai_insight_cache(project_id: int | None = None) -> int:
    return cache_delete_pattern(f"{AI_INSIGHT_KEY_PREFIX}:*")


register_invalidate_fn("ai_chat_v2", invalidate_ai_chat_v2_cache)
register_invalidate_fn("ai_insight", invalidate_ai_insight_cache)

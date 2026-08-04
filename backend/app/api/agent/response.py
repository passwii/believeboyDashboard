"""Agent API 统一响应壳（设计稿 §5.1）。"""

from __future__ import annotations

from typing import Any


def agent_ok(
    data: Any = None, *, idempotency_key: str | None = None, **extra: Any
) -> dict:
    """成功壳：``{"ok": true, "data": ..., "idempotency_key": ...}``。

    ``extra`` 用于 confirm 预览等附加字段（requires_confirmation 等）。
    """
    payload: dict[str, Any] = {"ok": True, "data": data}
    if idempotency_key is not None:
        payload["idempotency_key"] = idempotency_key
    payload.update(extra)
    return payload

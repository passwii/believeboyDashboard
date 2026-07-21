"""SSE 编码器 — 将 ProtocolEvent 编码为 SSE 字节流。

SSE 格式:
  id: {entry_id}\n       ← 可选(Redis Stream entry ID,供 Last-Event-ID resume)
  data: {json}\n
  \n                     ← 空行分隔事件

对应 V2 spec §5.3(SSE 编码)。
"""
from __future__ import annotations

from app.services.ai.protocol.events import ProtocolEvent


def encode_sse(event: ProtocolEvent, entry_id: str | None = None) -> bytes:
    """将 ProtocolEvent 编码为 SSE 格式字节。

    Args:
        event: 协议事件实例。
        entry_id: Redis Stream entry ID(可选)。提供时输出 `id:` 行,
                  前端可通过 Last-Event-ID 请求断点续传。

    Returns:
        UTF-8 编码的 SSE 字节,以 `\\n\\n` 结尾。
    """
    lines: list[str] = []
    if entry_id is not None:
        lines.append(f"id: {entry_id}")
    data = event.model_dump_json(exclude_none=True)
    lines.append(f"data: {data}")
    return ("\n".join(lines) + "\n\n").encode("utf-8")

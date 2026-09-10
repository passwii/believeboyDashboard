"""Insight SSE cursor：transport-independent canonical cursor。

- 外部 SSE `id` 固定为无空格字符串 `{run_id}:{attempt}:{seq}`，由 Last-Event-ID 原样回传。
- transport 可在内部保存其他 offset，但不得把内部 offset 直接暴露给前端。
- 非法/未来 cursor → RESUME_CURSOR_INVALID（由调用方转为 typed error）。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from app.schemas.insight import InsightErrorCode
from app.services.insight.events import TERMINAL_EVENT_TYPES, InsightEvent


class CursorError(Exception):
    """cursor 解析/恢复失败：固定携带 RESUME_CURSOR_INVALID。"""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.code = InsightErrorCode.RESUME_CURSOR_INVALID


@dataclass(frozen=True)
class ParsedCursor:
    run_id: UUID
    attempt: int
    seq: int


def format_event_id(run_id: UUID | str, attempt: int, seq: int) -> str:
    """拼外部 SSE id：`{run_id}:{attempt}:{seq}`，无空格。"""
    return f"{run_id}:{attempt}:{seq}"


def event_id_of(event: InsightEvent) -> str:
    return format_event_id(event.run_id, event.attempt, event.seq)


def parse_event_id(raw: str) -> ParsedCursor:
    """解析 Last-Event-ID；格式错误/非正整数/坏 UUID 一律 RESUME_CURSOR_INVALID。"""
    parts = raw.split(":")
    if len(parts) != 3 or not all(parts):
        raise CursorError(f"malformed cursor '{raw}': expected '{{run_id}}:{{attempt}}:{{seq}}'")
    run_part, attempt_part, seq_part = parts
    try:
        run_id = UUID(run_part, version=4)
    except ValueError:
        raise CursorError(f"malformed cursor '{raw}': run_id is not a UUID4") from None
    if any(ch.isspace() for ch in raw):
        raise CursorError(f"malformed cursor '{raw}': whitespace is not allowed")
    try:
        attempt = int(attempt_part)
        seq = int(seq_part)
    except ValueError:
        raise CursorError(f"malformed cursor '{raw}': attempt/seq must be integers") from None
    if attempt < 1 or seq < 1:
        raise CursorError(f"malformed cursor '{raw}': attempt/seq must be positive")
    return ParsedCursor(run_id=run_id, attempt=attempt, seq=seq)


def check_future_cursor(cursor: ParsedCursor, current_attempt: int) -> None:
    """cursor 指向未来 attempt → RESUME_CURSOR_INVALID。"""
    if cursor.attempt > current_attempt:
        raise CursorError(
            f"cursor attempt {cursor.attempt} is newer than current attempt {current_attempt}"
        )


def validate_attempt_sequence(events: list[InsightEvent]) -> None:
    """校验同一 attempt 内事件：同 run/attempt，seq 从 1 严格 +1；终态事件至多 1 个且必须收尾。

    跨 attempt 的列表由调用方按 attempt 分组后逐组校验。
    """
    if not events:
        return
    run_id = events[0].run_id
    attempt = events[0].attempt
    terminal_seen = 0
    for index, event in enumerate(events):
        expected_seq = index + 1
        if event.run_id != run_id or event.attempt != attempt:
            raise CursorError("events mix different (run_id, attempt); group by attempt first")
        if event.seq != expected_seq:
            raise CursorError(f"seq gap: expected {expected_seq}, got {event.seq}")
        if event.type in TERMINAL_EVENT_TYPES:
            terminal_seen += 1
            if index != len(events) - 1:
                raise CursorError(f"terminal event '{event.type}' must be the last event")
    if terminal_seen > 1:
        raise CursorError("at most one terminal event per attempt")


def group_by_attempt(events: list[InsightEvent]) -> dict[int, list[InsightEvent]]:
    """按 attempt 分组（保持原顺序）。"""
    grouped: dict[int, list[InsightEvent]] = {}
    for event in events:
        grouped.setdefault(event.attempt, []).append(event)
    return grouped

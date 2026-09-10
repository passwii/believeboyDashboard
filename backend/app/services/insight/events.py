"""Insight SSE 事件 discriminated union：七类事件 + 公共 envelope。

- 判别字段 `type`；公共字段 `schema_version=1` / `run_id` / `attempt` / `seq`。
- `seq` 在每个 attempt 内从 1 开始严格 +1；事件身份为 `(run_id, attempt, seq)`。
- 外部 SSE `id` 为 `{run_id}:{attempt}:{seq}`（见 cursor.py）。
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import UUID4, BaseModel, ConfigDict, Field, PositiveInt, TypeAdapter

from app.schemas.insight import (
    SHA256_HEX_PATTERN,
    InsightError,
    InsightOutput,
    InsightStage,
    InsightStatus,
)

_FROZEN = ConfigDict(extra="forbid")


class InsightEventEnvelope(BaseModel):
    model_config = _FROZEN

    schema_version: Literal[1]
    run_id: UUID4
    attempt: PositiveInt
    seq: PositiveInt


class SnapshotEvent(InsightEventEnvelope):
    type: Literal["snapshot"] = "snapshot"
    status: InsightStatus
    stage: InsightStage
    progress_percent: Annotated[int, Field(ge=0, le=100)]
    outputs: dict[str, InsightOutput] = Field(default_factory=dict)
    is_terminal: bool = False
    error: InsightError | None = None


class StatusEvent(InsightEventEnvelope):
    type: Literal["status"] = "status"
    status: InsightStatus
    stage: InsightStage
    progress_percent: Annotated[int, Field(ge=0, le=100)]
    detail: Annotated[str, Field(max_length=512)] | None = None


class ContentDeltaEvent(InsightEventEnvelope):
    type: Literal["content.delta"] = "content.delta"
    slot: str = Field(min_length=1)
    block_id: str = Field(min_length=1)
    format: Literal["markdown"] = "markdown"
    delta: str = Field(min_length=1)


class ContentSnapshotEvent(InsightEventEnvelope):
    type: Literal["content.snapshot"] = "content.snapshot"
    slot: str = Field(min_length=1)
    format: Literal["markdown"] = "markdown"
    content: str = Field(min_length=1)
    content_sha256: str = Field(pattern=SHA256_HEX_PATTERN)
    checkpoint_seq: PositiveInt


class DoneEvent(InsightEventEnvelope):
    type: Literal["done"] = "done"
    status: Literal["completed"] = "completed"
    outputs: dict[str, InsightOutput]
    artifact_id: str | None = None
    title: str | None = None
    content_sha256: str = Field(pattern=SHA256_HEX_PATTERN)
    usage: dict[str, int] | None = None


class ErrorEvent(InsightEventEnvelope):
    type: Literal["error"] = "error"
    status: Literal["failed", "cancelled"]
    error: InsightError


class PingEvent(InsightEventEnvelope):
    type: Literal["ping"] = "ping"


InsightEvent = Annotated[
    SnapshotEvent | StatusEvent | ContentDeltaEvent | ContentSnapshotEvent | DoneEvent | ErrorEvent | PingEvent,
    Field(discriminator="type"),
]

InsightEventAdapter: TypeAdapter[InsightEvent] = TypeAdapter(InsightEvent)

#: 终态事件类型：每个 attempt 恰好 0 或 1 个，`done` 与 `error` 互斥
TERMINAL_EVENT_TYPES = frozenset({"done", "error"})

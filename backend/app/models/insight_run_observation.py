"""Insight 观测期运行指标快照（BLF-1018）。

观测期（Stage 5）要按 run / capability 记账，而 ``insight_runs`` 只承载业务
状态（状态机、用量、错误），装不下传输与交互指标：首字时延、重连次数、取消
结果、Stream 体量、降级比例。本表是这些指标的**审计落点**：

- ``source='insight_run'``：一行 = 一个终态 run 的快照，``run_id`` 唯一；
  写入幂等（重复快照覆盖同一行），由终态写侧即时补写、聚合侧对账兜底。
  未终态的 run 不落行——观测期看的是已结算的一次执行。
- ``source='legacy_fallback'``：一行 = 一次未经 canonical Insight 服务的
  降级事件（``run_id`` 为空），供降级比例做分子。

不落敏感内容：system prompt、API key、base_url、原始 slot 一律不进本表，
只记错误码 / 模型 / 角色这类可审计字段（见
``app/services/insight/observation.py`` 的 ``SNAPSHOT_FORBIDDEN_SOURCES``）。
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base

#: 快照来源：canonical Insight run / 未经 canonical 服务的降级事件。
SOURCE_INSIGHT_RUN = "insight_run"
SOURCE_LEGACY_FALLBACK = "legacy_fallback"


class InsightRunObservation(Base):
    """One auditable metric snapshot per terminal run (or fallback event)."""

    __tablename__ = "insight_run_observations"
    __table_args__ = (
        # run_id 为空 = 降级事件行；唯一索引允许多个 NULL，故两类行共存不冲突。
        Index("ix_insight_run_observations_run_id", "run_id", unique=True),
        Index("ix_insight_run_observations_capability", "capability", "created_at"),
        Index("ix_insight_run_observations_status", "status"),
    )

    # Repository migration convention: plain Integer primary key.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    #: ``insight_run``（有 run_id）或 ``legacy_fallback``（无 run_id）。
    source: Mapped[str] = mapped_column(
        String(24), nullable=False, default=SOURCE_INSIGHT_RUN
    )
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    attempt: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: 聚合口径：capability 为粗桶（insight / ad_analysis / ai_summary…），
    #: role_id 为细桶（schedule_report_summary…），两者都按 run 记录。
    capability: Mapped[str] = mapped_column(String(64), nullable=False)
    role_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    endpoint_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    #: 终态状态值（completed/failed/cancelled）；降级事件行为空。
    status: Mapped[str | None] = mapped_column(String(32), nullable=True)

    #: 首字时延：attempt 起点 → 首个 content.delta 发布之间的毫秒数。
    first_delta_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: 总时长（``insight_runs.duration_ms`` 的同口径副本，便于单表聚合）。
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: 该 run 的尝试代数与显式重试次数（attempt - 1）。
    attempts: Mapped[int | None] = mapped_column(Integer, nullable=True)
    retries: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: 传输侧计数（Redis 计数器快照）：订阅次数 / 带游标重连次数 / 发布帧数。
    stream_opens: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    stream_reconnects: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    #: 续传闭环：带游标重连后确实观测到终态帧（由 SSE 端点写入的 0/1 计数器）。
    #: ``stream_reconnects`` 只说明「重连过」，这一列才说明「重连补回了终态」。
    reconnect_completed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    stream_frames: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    #: Redis Stream 体量：已发布载荷字节数（累计）+ 快照时 XLEN / MEMORY USAGE。
    stream_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stream_xlen: Mapped[int | None] = mapped_column(Integer, nullable=True)
    stream_memory_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: 取消：是否发起过取消（非终态时的取消请求）与是否真的取消成功。
    cancel_requested: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    cancel_succeeded: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    #: 错误类型（InsightErrorCode 值）与是否可重试。
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    error_retryable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    #: 降级：本 run 由非 canonical 路径服务（分子）或事件原因。
    fallback: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    fallback_reason: Mapped[str | None] = mapped_column(String(128), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


__all__ = [
    "SOURCE_INSIGHT_RUN",
    "SOURCE_LEGACY_FALLBACK",
    "InsightRunObservation",
]

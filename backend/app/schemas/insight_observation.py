"""Insight 观测期（Stage 5 / BLF-1018）门禁与退役就绪度的响应契约。

只读契约：指标由 canonical run 的终态快照与降级事件聚合而来，退役判定
永不在此臆造 —— 第三票（CodeGraph 调用方清零）必须由审计脚本
``backend/scripts/insight_gate.py`` 产出并附证据。

``extra="forbid"`` 与 ``app/schemas/insight.py`` 一致：``GateReport.as_dict()``
（审计脚本直接打印的同一份 JSON）必须能被这里校验，两端一旦漂移立即报错。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ObservationThresholds(BaseModel):
    """生效的门禁阈值（与 ``Settings`` 一一对应，便于审计「当时的判据」）。"""

    model_config = ConfigDict(extra="forbid")

    duration_ms: int = Field(description="单 run 总时长上限；0 = 不判定")
    first_delta_ms: int = Field(description="首包延迟上限；0 = 不判定")
    stream_frames: int = Field(description="单 run 事件帧上限；0 = 不判定")
    fallback_ratio: float = Field(description="降级比例上限；0 = 不判定")
    cost_anomaly_multiplier: float = Field(description="成本异常倍数（非仓库既有数字）")


class CapabilityMetricsOut(BaseModel):
    """一个 capability 桶在观测窗口内的聚合结果。"""

    model_config = ConfigDict(extra="forbid")

    capability: str
    runs: int
    completed: int
    failed: int
    cancelled: int
    fallback_events: int
    fallback_ratio: float
    error_rate: float
    error_counts: dict[str, int]
    retried_runs: int
    cancel_requested: int
    cancel_succeeded: int
    cancel_success_rate: float | None
    stream_opens: int
    stream_reconnects: int
    reconnect_rate: float
    stream_frames: int
    stream_bytes: int
    max_stream_xlen: int | None
    max_stream_memory_bytes: int | None
    total_tokens: int
    avg_duration_ms: int | None
    p95_duration_ms: int | None
    max_duration_ms: int | None
    avg_first_delta_ms: int | None
    p95_first_delta_ms: int | None
    max_first_delta_ms: int | None
    cost_anomalies: list[str]


class GateFindingOut(BaseModel):
    """一条可审计的阈值结论（观测值 vs 阈值 + 严重级）。"""

    model_config = ConfigDict(extra="forbid")

    code: str
    severity: str
    capability: str
    metric: str
    observed: Any
    threshold: Any
    detail: str = ""


class ObservationGateResponse(BaseModel):
    """``GET /insight/observation/gate`` —— 指标达标与否的唯一权威口径。"""

    model_config = ConfigDict(extra="forbid")

    window_days: int
    generated_at: datetime
    eligible_for_retirement: bool = Field(description="指标票；不含调用方/演练两票")
    blocking_count: int
    thresholds: ObservationThresholds
    bucket_caps: dict[str, int] = Field(description="各并发桶上限（观测值 vs 配置）")
    buckets: list[CapabilityMetricsOut]
    findings: list[GateFindingOut]


class RetirementReadiness(BaseModel):
    """退役就绪度：把三票拆开显示，缺哪票一眼可见。

    ``codegraph_verified`` 恒为 ``None``：调用方清零这一票只能来自审计脚本
    的静态证据，接口不做任何推断。
    """

    model_config = ConfigDict(extra="forbid")

    metrics_ok: bool
    metrics_reasons: list[str]
    canonical_domains: list[str]
    frozen_legacy_domains: list[str]
    rollback_switch: str = Field(description="清空 insight_canonical_domains 即回滚")
    legacy_reads_preserved: bool
    codegraph_verified: bool | None = Field(
        default=None, description="调用方清零票 —— 由脚本产出，接口不推断"
    )
    eligible: bool = Field(description="metrics_ok 且 codegraph_verified 已通过")
    blocking_count: int


__all__ = [
    "CapabilityMetricsOut",
    "GateFindingOut",
    "ObservationGateResponse",
    "ObservationThresholds",
    "RetirementReadiness",
]

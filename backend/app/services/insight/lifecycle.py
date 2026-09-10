"""Insight 生命周期：合法转换表、终态判定、cancel/retry 幂等规则。

状态机：`queued → aggregating → generating → finalizing → completed|failed|cancelled`，
允许从任一非终态直接失败/取消；终态不可回退、不可再次终结；重试只允许 failed/cancelled。
"""

from __future__ import annotations

from itertools import pairwise

from app.schemas.insight import InsightErrorCode, InsightStatus


class LifecycleError(Exception):
    """生命周期违规：携带 INVALID_STATE_TRANSITION 或 RUN_TERMINAL。"""

    def __init__(self, code: InsightErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


TERMINAL_STATUSES = frozenset(
    {InsightStatus.COMPLETED, InsightStatus.FAILED, InsightStatus.CANCELLED}
)

#: 非终态 → 允许的目标（含直接失败/取消；跳过中间阶段视为合法快进）
_TRANSITIONS: dict[InsightStatus, frozenset[InsightStatus]] = {
    InsightStatus.QUEUED: frozenset(
        {
            InsightStatus.AGGREGATING,
            InsightStatus.GENERATING,
            InsightStatus.FINALIZING,
            InsightStatus.FAILED,
            InsightStatus.CANCELLED,
        }
    ),
    InsightStatus.AGGREGATING: frozenset(
        {
            InsightStatus.GENERATING,
            InsightStatus.FINALIZING,
            InsightStatus.FAILED,
            InsightStatus.CANCELLED,
        }
    ),
    InsightStatus.GENERATING: frozenset(
        {InsightStatus.FINALIZING, InsightStatus.FAILED, InsightStatus.CANCELLED}
    ),
    InsightStatus.FINALIZING: frozenset(
        {InsightStatus.COMPLETED, InsightStatus.FAILED, InsightStatus.CANCELLED}
    ),
    InsightStatus.COMPLETED: frozenset(),
    InsightStatus.FAILED: frozenset(),
    InsightStatus.CANCELLED: frozenset(),
}


def is_terminal(status: InsightStatus) -> bool:
    return status in TERMINAL_STATUSES


def can_transition(frm: InsightStatus, to: InsightStatus) -> bool:
    return to in _TRANSITIONS[frm]


def require_transition(frm: InsightStatus, to: InsightStatus) -> None:
    """非法回退/终态再次终结 → INVALID_STATE_TRANSITION；终态作源 → RUN_TERMINAL。"""
    if is_terminal(frm):
        raise LifecycleError(
            InsightErrorCode.RUN_TERMINAL,
            f"run is already terminal ({frm.value}); transition to {to.value} is not allowed",
        )
    if not can_transition(frm, to):
        raise LifecycleError(
            InsightErrorCode.INVALID_STATE_TRANSITION,
            f"transition {frm.value} -> {to.value} is not allowed",
        )


def check_status_path(statuses: list[InsightStatus]) -> None:
    """校验状态序列每一步合法（跳过中间阶段允许；回退/终态后继续不允许）。"""
    for frm, to in pairwise(statuses):
        require_transition(frm, to)


def can_cancel(status: InsightStatus) -> bool:
    """cancel 仅对非终态 attempt 有效；重复 cancel 由调用方幂等返回当前状态。"""
    return not is_terminal(status)


def require_cancellable(status: InsightStatus) -> None:
    if not can_cancel(status):
        raise LifecycleError(
            InsightErrorCode.RUN_TERMINAL,
            f"run is already terminal ({status.value}); cancel is not allowed",
        )


def can_retry(status: InsightStatus) -> bool:
    """retry 仅 failed/cancelled 可重试；completed 不可重试。"""
    return status in (InsightStatus.FAILED, InsightStatus.CANCELLED)


def require_retryable(status: InsightStatus) -> None:
    if not can_retry(status):
        raise LifecycleError(
            InsightErrorCode.RUN_TERMINAL if is_terminal(status) else InsightErrorCode.INVALID_STATE_TRANSITION,
            f"status {status.value} is not retryable; only failed/cancelled runs can retry",
        )


def next_attempt(current_attempt: int) -> int:
    """retry 保留 run_id、attempt +1；新 attempt 内 seq 从 1 重启。"""
    if current_attempt < 1:
        raise LifecycleError(
            InsightErrorCode.INVALID_STATE_TRANSITION,
            f"invalid current attempt {current_attempt}",
        )
    return current_attempt + 1

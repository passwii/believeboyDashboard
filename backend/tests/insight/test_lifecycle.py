"""I-5：状态机与 cancel/retry 规则测试。"""

from __future__ import annotations

import pytest

from app.schemas.insight import InsightErrorCode, InsightStatus
from app.services.insight.lifecycle import (
    LifecycleError,
    can_cancel,
    can_retry,
    check_status_path,
    is_terminal,
    next_attempt,
    require_cancellable,
    require_retryable,
    require_transition,
)

Q = InsightStatus.QUEUED
AG = InsightStatus.AGGREGATING
GE = InsightStatus.GENERATING
FI = InsightStatus.FINALIZING


def test_happy_path_and_stage_skipping():
    check_status_path([Q, AG, GE, FI, InsightStatus.COMPLETED])
    check_status_path([Q, FI, InsightStatus.COMPLETED])  # 快进合法
    check_status_path([Q, InsightStatus.FAILED])
    check_status_path([GE, InsightStatus.CANCELLED])


def test_terminal_is_terminal_and_no_transition_out():
    for terminal in (InsightStatus.COMPLETED, InsightStatus.FAILED, InsightStatus.CANCELLED):
        assert is_terminal(terminal)
        with pytest.raises(LifecycleError) as exc:
            require_transition(terminal, InsightStatus.FAILED)
        assert exc.value.code == InsightErrorCode.RUN_TERMINAL


def test_backward_transition_rejected():
    with pytest.raises(LifecycleError) as exc:
        require_transition(GE, AG)
    assert exc.value.code == InsightErrorCode.INVALID_STATE_TRANSITION
    with pytest.raises(LifecycleError) as exc:
        check_status_path([Q, AG, GE, AG])
    assert exc.value.code == InsightErrorCode.INVALID_STATE_TRANSITION


def test_terminal_repeat_is_terminal_not_transition():
    with pytest.raises(LifecycleError) as exc:
        check_status_path([Q, FI, InsightStatus.COMPLETED, InsightStatus.COMPLETED])
    assert exc.value.code == InsightErrorCode.RUN_TERMINAL


def test_cancel_rules():
    assert can_cancel(Q) and can_cancel(FI)
    assert not can_cancel(InsightStatus.COMPLETED)
    require_cancellable(AG)
    with pytest.raises(LifecycleError) as exc:
        require_cancellable(InsightStatus.FAILED)
    assert exc.value.code == InsightErrorCode.RUN_TERMINAL


def test_retry_only_failed_cancelled():
    assert can_retry(InsightStatus.FAILED)
    assert can_retry(InsightStatus.CANCELLED)
    assert not can_retry(InsightStatus.COMPLETED)
    assert not can_retry(GE)
    require_retryable(InsightStatus.FAILED)
    with pytest.raises(LifecycleError) as exc:
        require_retryable(InsightStatus.COMPLETED)
    assert exc.value.code == InsightErrorCode.RUN_TERMINAL
    with pytest.raises(LifecycleError) as exc:
        require_retryable(GE)
    assert exc.value.code == InsightErrorCode.INVALID_STATE_TRANSITION


def test_next_attempt_increments():
    assert next_attempt(1) == 2
    with pytest.raises(LifecycleError):
        next_attempt(0)


def test_old_attempt_events_must_not_merge():
    # 旧 attempt 事件混入新 attempt 由 cursor 层拒绝；这里锁定状态机侧语义：
    # completed 之后任何事件（即使新 attempt 名义）都不能复用同一状态路径
    with pytest.raises(LifecycleError):
        check_status_path([Q, FI, InsightStatus.COMPLETED, GE])

"""异常分类单测。"""
import asyncio

from app.services.ai.orchestrator.runner import classify_error, CancelledError
from app.services.ai.protocol.errors import ErrorCode


def test_cancelled_error():
    err = classify_error(CancelledError())
    assert err.code == ErrorCode.CANCELLED


def test_timeout_error():
    err = classify_error(asyncio.TimeoutError())
    assert err.code == ErrorCode.TIMEOUT


def test_runtime_error_to_internal():
    err = classify_error(RuntimeError("simulated 500"))
    assert err.code == ErrorCode.INTERNAL


def test_default_internal():
    err = classify_error(ValueError("something"))
    assert err.code == ErrorCode.INTERNAL
    assert "something" in err.message

"""Contract tests for the independent Insight provider/model adapter."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.test import TestModel

from app.services.insight.provider import (
    DEFAULT_ENDPOINT_ID,
    InsightModelResolver,
    InsightProviderError,
    InsightProviderErrorCode,
)


class FakeSettings:
    ai_chat_provider_base_url = "https://llm.example.test/v1"
    ai_chat_provider_api_key = "server-secret-key"
    ai_chat_default_model = "insight-default"
    ai_chat_backup_model = ""
    ai_chat_model_blocklist = ""
    ai_chat_basic_models = "insight-default,insight-fast"
    ai_chat_premium_models = "insight-premium"
    ai_chat_reasoning_models = ""
    ai_chat_timeout_seconds = 12
    insight_default_endpoint_id = "default"
    insight_endpoint_ids = "default"
    insight_default_model = ""
    insight_role_default_models = ""
    #: 供应商现役模型并入 allowlist 的开关（BLF-1016）。默认关闭，测试按需打开。
    insight_allow_provider_models = False


def test_default_endpoint_builds_openai_compatible_model_without_public_secret():
    resolver = InsightModelResolver(FakeSettings())

    resolved = resolver.resolve_model()

    assert resolved.endpoint_id == DEFAULT_ENDPOINT_ID
    assert resolved.model_id == "insight-default"
    assert isinstance(resolved.model, OpenAIChatModel)
    assert resolved.public_metadata() == {
        "endpoint_id": DEFAULT_ENDPOINT_ID,
        "model": "insight-default",
    }
    assert "server-secret-key" not in repr(resolved)
    assert "llm.example.test" not in repr(resolved)


def test_explicit_model_requires_server_allowlist():
    resolver = InsightModelResolver(FakeSettings())

    with pytest.raises(InsightProviderError) as exc_info:
        resolver.resolve_model(model_id="client-selected-model")

    error = exc_info.value
    assert error.code is InsightProviderErrorCode.MODEL_NOT_ALLOWED
    assert error.retryable is False
    assert error.retry_after is None
    assert "client-selected-model" not in str(error)
    assert "server-secret-key" not in str(error)


def test_blocklisted_model_is_rejected_even_when_allowlisted():
    settings = FakeSettings()
    settings.ai_chat_model_blocklist = "insight-fast"
    resolver = InsightModelResolver(settings)

    with pytest.raises(InsightProviderError) as exc_info:
        resolver.resolve_model(model_id="insight-fast")

    assert exc_info.value.code is InsightProviderErrorCode.MODEL_NOT_ALLOWED
    assert exc_info.value.retryable is False


def test_unconfigured_provider_is_typed_and_non_retryable():
    settings = FakeSettings()
    settings.ai_chat_provider_api_key = ""
    resolver = InsightModelResolver(settings)

    with pytest.raises(InsightProviderError) as exc_info:
        resolver.resolve_model()

    error = exc_info.value
    assert error.code is InsightProviderErrorCode.PROVIDER_NOT_CONFIGURED
    assert error.retryable is False
    assert error.public_dict() == {
        "code": "provider_not_configured",
        "message": "Insight AI provider is not configured",
        "retryable": False,
    }


def test_role_default_can_be_overridden_by_an_allowlisted_model():
    settings = FakeSettings()
    settings.ai_chat_default_model = "chat-default"
    settings.ai_chat_basic_models = "role-default,role-override"
    resolver = InsightModelResolver(
        settings,
        role_default_models={"schedule_report_summary.v1": "role-default"},
    )

    role_default = resolver.resolve_model(role_id="schedule_report_summary.v1")
    controlled_override = resolver.resolve_model(
        role_id="schedule_report_summary.v1",
        model_id="role-override",
    )

    assert role_default.model_id == "role-default"
    assert controlled_override.model_id == "role-override"


def test_test_model_can_be_used_for_isolated_insight_streaming():
    settings = FakeSettings()
    resolver = InsightModelResolver(
        settings,
        model_factory=lambda _model_id, _endpoint: TestModel(
            custom_output_text="streamed insight"
        ),
    )
    resolved = resolver.resolve_model()
    agent = resolver.create_agent(resolved)

    async def collect() -> str:
        chunks: list[str] = []
        async for chunk in resolver.stream_text(agent, "summarize"):
            chunks.append(chunk)
        return "".join(chunks)

    assert asyncio.run(collect()) == "streamed insight"


def test_open_text_stream_yields_real_deltas_and_terminal_usage():
    """``open_text_stream`` 给出真 delta，并在流结束后可读 usage/state。

    锁住 BLF-1071 的生产接缝：executor 要在流结束后拿到真实 token usage
    （终态写一次），而裸 ``AsyncIterator[str]`` 带不回这个事实。
    """
    from app.services.insight.provider import open_text_stream

    resolver = InsightModelResolver(
        FakeSettings(),
        model_factory=lambda _model_id, _endpoint: TestModel(
            custom_output_text="## 摘要\n- 要点"
        ),
    )
    agent = resolver.create_agent(resolver.resolve_model())

    async def drive() -> tuple[list[str], bool, str | None, tuple[int, int]]:
        stream = open_text_stream(agent, "summarize")
        chunks = [chunk async for chunk in stream]
        return chunks, stream.finished, stream.state, stream.usage_tokens

    chunks, finished, state, usage = asyncio.run(drive())

    # 真 delta：多于一帧，且拼接回完整正文。
    assert len(chunks) > 1
    assert "".join(chunks) == "## 摘要\n- 要点"
    assert finished is True
    assert state == "complete"
    assert usage[0] > 0 and usage[1] > 0


def test_truncated_reflects_provider_response_state():
    """``truncated`` 只看供应商自报的响应状态——这是截断守卫的全部契约。

    为什么不能用假模型模拟：``FunctionModel`` / ``TestModel`` 总会把流跑到
    自然结束（state=``complete``），所以能造出「只有半截正文」的观感，却造不出
    真正的 ``incomplete``。真上游（如 OpenAI Responses 在 EOF 未终止事件时）
    才会把状态留在 ``incomplete``；执行器侧的截断分支用 FakeStream 显式注入
    ``incomplete`` 覆盖（见 ``test_executor_streaming.py``）。
    """
    from app.services.insight.provider import (
        InsightStreamResult,
        InsightTextStream,
    )

    def _stream_for(state: str | None) -> InsightTextStream:
        async def source():
            yield "正文"

        result = InsightStreamResult(finished=True, state=state)
        return InsightTextStream(source(), result)

    async def truncated_of(state: str | None) -> bool:
        stream = _stream_for(state)
        async for _chunk in stream:
            pass
        return stream.truncated

    assert asyncio.run(truncated_of("complete")) is False
    assert asyncio.run(truncated_of("incomplete")) is True
    assert asyncio.run(truncated_of("interrupted")) is True
    # 供应商没报状态时不让路：把未报当截断会误杀一批好 run。
    assert asyncio.run(truncated_of(None)) is False


def test_unfinished_stream_reports_no_usage():
    """未跑完的流不报 usage：绝不能把半截流当成「零 token 完成」。"""
    from app.services.insight.provider import InsightTextStream

    async def source():
        yield "a"
        raise RuntimeError("provider died")

    async def drive() -> tuple[bool, tuple[int, int]]:
        stream = InsightTextStream(source(), None)
        with pytest.raises(RuntimeError):
            async for _chunk in stream:
                pass
        return stream.finished, stream.usage_tokens

    finished, usage = asyncio.run(drive())

    assert finished is False
    assert usage == (0, 0)


def test_insight_text_stream_aclose_closes_source_once_and_is_idempotent():
    """``InsightTextStream.aclose`` 是幂等的，且真的关到底层 async generator。

    执行器在 ``_consume_stream`` 的 ``finally`` 里调它（消费被中止 / 取消 / 重试时），
    所以这一层必须把关闭动作透传下去，重复调用也不能炸（重投的 attempt 可能关两次）。
    """
    from app.services.insight.provider import InsightTextStream

    closed: list[str] = []

    async def source():
        try:
            yield "a"
            yield "b"
        finally:
            closed.append("closed")

    async def drive() -> tuple[str, Any]:
        stream = InsightTextStream(source(), None)
        first = await stream.__anext__()
        await stream.aclose()
        await stream.aclose()  # 幂等：第二次必须是 no-op
        return first, stream

    first, stream = asyncio.run(drive())

    assert first == "a"
    assert closed == ["closed"]
    # 提前关闭不等于「跑完」：终态事实仍按未完成上报。
    assert stream.finished is False
    assert stream.usage_tokens == (0, 0)


def test_insight_text_stream_tolerates_a_source_without_aclose():
    """裸 async iterator（无 ``aclose``）不能被包装层弄成异常。"""
    from app.services.insight.provider import InsightTextStream

    class _BareIterator:
        def __init__(self) -> None:
            self._items = ["x"]

        def __aiter__(self) -> _BareIterator:
            return self

        async def __anext__(self) -> str:
            if not self._items:
                raise StopAsyncIteration
            return self._items.pop(0)

    async def drive() -> None:
        stream = InsightTextStream(_BareIterator(), None)
        assert [chunk async for chunk in stream] == ["x"]
        await stream.aclose()

    asyncio.run(drive())


def test_aborted_consumption_exits_the_provider_async_context():
    """消费中止时必须真的退出 ``agent.run_stream`` 的 async context。

    回归（Tia 阻塞项）：执行器旧写法只对注入对象 duck-type 查 ``stream.aclose``，
    而生产 wrapper 当时没有 ``aclose`` —— 生产路径下 ``_consume_stream`` 不会显式
    关流，只能等异步生成器回收触发 ``GeneratorExit``，上游 HTTP 请求/计费得不到
    及时释放。本用例走**真实** ``open_text_stream`` wrapper，只把 agent 换成替身，
    断言 ``__aexit__`` 在消费中止时已被调用。
    """
    from app.services.insight.provider import open_text_stream

    class _FakeRun:
        def __init__(self) -> None:
            self.response = None
            self.usage = None

        async def stream_text(self, delta: bool = True, debounce_by: Any = None):
            yield "## 一\n"
            yield "二\n"
            yield "三\n"

    class _RecordingAgent:
        def __init__(self) -> None:
            self.exited = False

        @asynccontextmanager
        async def run_stream(self, _prompt: str):
            try:
                yield _FakeRun()
            finally:
                self.exited = True

    agent = _RecordingAgent()

    async def drive() -> None:
        stream = open_text_stream(agent, "prompt")
        seen: list[str] = []
        async for chunk in stream:
            seen.append(chunk)
            break  # 消费方中途放弃，就像 sink/guard 抛 _StreamAborted
        # 尚未关闭：async context 由 aclose() 负责退出。
        assert agent.exited is False
        await stream.aclose()
        await stream.aclose()  # 幂等
        assert seen == ["## 一\n"]

    asyncio.run(drive())

    assert agent.exited is True


def test_provider_advertised_models_extend_the_allowlist():
    """UI 下拉与 Insight allowlist 必须同源：供应商现役模型名必须可解析。

    回归：订阅预设 ``GPT-5.6-Luna``（代理的大小写敏感真实 id）
    只出现在供应商 /v1/models 里，静态 AI_CHAT_* 清单没跟上 → 提交 run 时
    MODEL_NOT_ALLOWED。
    """
    settings = FakeSettings()
    settings.insight_allow_provider_models = True
    resolver = InsightModelResolver(settings, model_lister=lambda: ["GPT-5.6-Luna"])

    resolved = resolver.resolve_model(model_id="GPT-5.6-Luna")

    assert resolved.model_id == "GPT-5.6-Luna"


def test_provider_listing_failure_keeps_static_allowlist_only():
    """代理抖动（拉不到清单）不得放行未知模型，也不得打死静态 allowlist。"""
    settings = FakeSettings()
    settings.insight_allow_provider_models = True

    def _boom() -> list[str]:
        raise RuntimeError("provider down")

    resolver = InsightModelResolver(settings, model_lister=_boom)

    assert resolver.resolve_model(model_id="insight-fast").model_id == "insight-fast"
    with pytest.raises(InsightProviderError) as exc_info:
        resolver.resolve_model(model_id="GPT-5.6-Luna")
    assert exc_info.value.code is InsightProviderErrorCode.MODEL_NOT_ALLOWED


def test_provider_advertised_models_still_respect_blocklist():
    settings = FakeSettings()
    settings.insight_allow_provider_models = True
    settings.ai_chat_model_blocklist = "GPT-5.6-Luna"
    resolver = InsightModelResolver(settings, model_lister=lambda: ["GPT-5.6-Luna"])

    with pytest.raises(InsightProviderError) as exc_info:
        resolver.resolve_model(model_id="GPT-5.6-Luna")

    assert exc_info.value.code is InsightProviderErrorCode.MODEL_NOT_ALLOWED


def test_provider_listing_stays_off_without_the_setting():
    """未开启开关的 settings 形状（老配置 / 单测替身）不得触发供应商拉取。"""
    calls: list[str] = []
    resolver = InsightModelResolver(
        FakeSettings(),
        model_lister=lambda: calls.append("called") or ["GPT-5.6-Luna"],
    )

    with pytest.raises(InsightProviderError) as exc_info:
        resolver.resolve_model(model_id="GPT-5.6-Luna")

    assert exc_info.value.code is InsightProviderErrorCode.MODEL_NOT_ALLOWED
    assert calls == []


def test_fetch_provider_model_ids_reads_the_configured_provider(monkeypatch):
    """默认真实取数走既有 provider 客户端（不在 insight 侧再实现一遍）。"""
    import app.services.ai.llm as llm_mod
    from app.services.insight import provider as provider_mod

    monkeypatch.setattr(
        llm_mod,
        "fetch_models_from_provider",
        lambda *_args, **_kwargs: ["GPT-5.6-Luna", "Believeboy-Nano"],
    )
    provider_mod._provider_models_cache = None

    ids = provider_mod.fetch_provider_model_ids(FakeSettings(), ttl_seconds=0)

    assert ids == frozenset({"GPT-5.6-Luna", "Believeboy-Nano"})


def test_fetch_provider_model_ids_serves_stale_cache_on_failure(monkeypatch):
    """首次成功后可容忍后续拉取失败（不让代理抖动变成提交失败）。"""
    import app.services.ai.llm as llm_mod
    from app.services.insight import provider as provider_mod

    provider_mod._provider_models_cache = None
    monkeypatch.setattr(
        llm_mod, "fetch_models_from_provider", lambda *_a, **_k: ["GPT-5.6-Luna"]
    )
    assert provider_mod.fetch_provider_model_ids(FakeSettings(), ttl_seconds=0) == frozenset(
        {"GPT-5.6-Luna"}
    )

    def _boom(*_args, **_kwargs):
        raise httpx.ConnectError("proxy down")

    monkeypatch.setattr(llm_mod, "fetch_models_from_provider", _boom)
    assert provider_mod.fetch_provider_model_ids(FakeSettings(), ttl_seconds=0) == frozenset(
        {"GPT-5.6-Luna"}
    )

    provider_mod._provider_models_cache = None


def test_rate_limit_during_stream_is_retryable_and_redacted():
    settings = FakeSettings()
    resolver = InsightModelResolver(settings)
    secret = settings.ai_chat_provider_api_key
    response = httpx.Response(
        429,
        headers={"retry-after": "17"},
        request=httpx.Request("POST", settings.ai_chat_provider_base_url),
        content=f"provider leaked {secret}".encode(),
    )

    class FailingAgent:
        @asynccontextmanager
        async def run_stream(self, *_args, **_kwargs):
            raise httpx.HTTPStatusError("upstream details", request=response.request, response=response)
            yield

    async def consume() -> None:
        async for _chunk in resolver.stream_text(FailingAgent(), "summarize"):
            pass

    with pytest.raises(InsightProviderError) as exc_info:
        asyncio.run(consume())

    error = exc_info.value
    assert error.code is InsightProviderErrorCode.UPSTREAM_RATE_LIMITED
    assert error.retryable is True
    assert error.retry_after == 17
    assert secret not in str(error)
    assert secret not in repr(error)


def test_timeout_during_stream_is_retryable():
    resolver = InsightModelResolver(FakeSettings())

    class FailingAgent:
        @asynccontextmanager
        async def run_stream(self, *_args, **_kwargs):
            raise httpx.ReadTimeout("server-secret-key timeout")
            yield

    async def consume() -> None:
        async for _chunk in resolver.stream_text(FailingAgent(), "summarize"):
            pass

    with pytest.raises(InsightProviderError) as exc_info:
        asyncio.run(consume())

    error = exc_info.value
    assert error.code is InsightProviderErrorCode.UPSTREAM_TIMEOUT
    assert error.retryable is True
    assert "server-secret-key" not in str(error)


def test_public_facade_uses_server_policy():
    from app.services.insight.model_resolver import resolve_insight_model

    selection = resolve_insight_model(
        FakeSettings(),
        role_id="schedule_report_summary.v1",
        role_default_models={"schedule_report_summary.v1": "insight-fast"},
    )

    assert selection.public_metadata() == {
        "endpoint_id": DEFAULT_ENDPOINT_ID,
        "model": "insight-fast",
    }


def test_non_retryable_upstream_client_error_is_classified_without_details():
    from app.services.insight.provider import classify_provider_error

    response = httpx.Response(
        400,
        request=httpx.Request("POST", "https://llm.example.test/v1"),
        content=b"server-secret-key must not leak",
    )
    error = classify_provider_error(
        httpx.HTTPStatusError("private details", request=response.request, response=response)
    )

    assert error.code is InsightProviderErrorCode.UPSTREAM_ERROR
    assert error.retryable is False
    assert "server-secret-key" not in str(error)


def test_configured_endpoint_default_builds_model_without_secret_leak():
    settings = FakeSettings()
    settings.insight_endpoint_ids = "default,regional"
    settings.insight_default_endpoint_id = "regional"
    resolver = InsightModelResolver(settings)

    resolved = resolver.resolve_model()

    assert resolved.endpoint_id == "regional"
    assert isinstance(resolved.model, OpenAIChatModel)
    assert resolved.public_metadata() == {
        "endpoint_id": "regional",
        "model": "insight-default",
    }
    assert "server-secret-key" not in repr(resolved)

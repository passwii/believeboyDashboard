"""Contract tests for the independent Insight provider/model adapter."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

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

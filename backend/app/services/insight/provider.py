"""Server-side provider and model resolution for canonical Insight runs.

This module is intentionally independent from the legacy ``ai`` service.  It
owns the boundary between server-side provider credentials and the public
Insight run contract:

* callers select only an endpoint id and an allowlisted model id;
* the default endpoint is built from server settings;
* runtime Pydantic AI models never enter response or audit payloads; and
* provider failures are converted to stable, secret-free error values.

Role/slot validation remains the responsibility of the Insight role registry.
The registry can pass a role's default model policy to ``InsightModelResolver``
without duplicating provider construction in each business adapter.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

import httpx
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

logger = logging.getLogger(__name__)

DEFAULT_ENDPOINT_ID = "default"
DEFAULT_ROLE_ID = "schedule_report_summary.v1"


class _SettingsLike(Protocol):
    """The server-side settings required by the Insight provider boundary."""

    ai_chat_provider_base_url: str
    ai_chat_provider_api_key: str
    ai_chat_default_model: str
    ai_chat_model_blocklist: str
    ai_chat_basic_models: str
    ai_chat_premium_models: str
    ai_chat_timeout_seconds: int
    insight_default_endpoint_id: str
    insight_endpoint_ids: str
    insight_default_model: str
    insight_role_default_models: str

def _split_models(value: str) -> set[str]:
    """Parse a comma-separated server model list without preserving blanks."""

    return {item.strip() for item in value.split(",") if item.strip()}


def _parse_role_defaults(value: str) -> dict[str, str]:
    """Parse ``role_id=model_id`` pairs from server-side settings."""

    defaults: dict[str, str] = {}
    for item in value.split(","):
        role_id, separator, model_id = item.partition("=")
        if separator and role_id.strip() and model_id.strip():
            defaults[role_id.strip()] = model_id.strip()
    return defaults


def _provider_is_configured(settings: _SettingsLike) -> bool:
    """Return whether both server-side endpoint credentials are present."""

    return bool(
        settings.ai_chat_provider_base_url.strip()
        and settings.ai_chat_provider_api_key.strip()
    )

def _trim_trailing_slash(value: str) -> str:
    return value.removesuffix("/")

class InsightProviderErrorCode(str, Enum):
    """Stable error codes for Insight run/API layers."""

    PROVIDER_NOT_CONFIGURED = "provider_not_configured"
    ENDPOINT_NOT_ALLOWED = "endpoint_not_allowed"
    MODEL_NOT_ALLOWED = "model_not_allowed"
    MODEL_UNAVAILABLE = "model_unavailable"
    UPSTREAM_RATE_LIMITED = "upstream_rate_limited"
    UPSTREAM_TIMEOUT = "upstream_timeout"
    UPSTREAM_ERROR = "upstream_error"


class InsightProviderError(Exception):
    """Secret-free, classified provider failure.

    ``message`` is always selected by this module.  Upstream response bodies,
    exception strings, request URLs, and credentials are deliberately omitted
    from both the public payload and ``str``/``repr`` output.
    """

    def __init__(
        self,
        code: InsightProviderErrorCode,
        message: str,
        *,
        retryable: bool,
        retry_after: int | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retry_after = retry_after
        super().__init__(message)

    def public_dict(self) -> dict[str, Any]:
        """Return the only representation suitable for API/audit payloads."""

        payload: dict[str, Any] = {
            "code": self.code.value,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.retry_after is not None:
            payload["retry_after"] = self.retry_after
        return payload

    def __repr__(self) -> str:
        return (
            f"InsightProviderError(code={self.code.value!r}, "
            f"retryable={self.retryable!r}, retry_after={self.retry_after!r})"
        )


@dataclass(frozen=True, slots=True)
class InsightModelSelection:
    """A safe public model reference paired with a private runtime model.

    ``model`` is needed by the executor but is intentionally excluded from the
    custom representation and from ``public_metadata``.  Persist/API layers
    must use ``public_metadata`` rather than serializing this object wholesale.
    """

    endpoint_id: str
    model_id: str
    model: Model

    def public_metadata(self) -> dict[str, str]:
        """Return endpoint/model identifiers only; never provider secrets."""

        return {"endpoint_id": self.endpoint_id, "model": self.model_id}

    def __repr__(self) -> str:
        return (
            f"InsightModelSelection(endpoint_id={self.endpoint_id!r}, "
            f"model_id={self.model_id!r})"
        )


class _StreamAgent(Protocol):
    def run_stream(self, user_prompt: str, **kwargs: Any) -> Any:
        """Return an async context manager yielding a streamed run result."""


ModelFactory = Callable[[str, str], Model]


class InsightModelResolver:
    """Resolve and execute allowlisted server-side Insight models.

    ``role_default_models`` is supplied by the versioned role registry.  A
    role-specific model is only a default: every selected model, including a
    client-requested override, still has to pass the server allowlist and
    blocklist.
    """

    @classmethod
    def from_role_registry(
        cls,
        settings: _SettingsLike,
        registry: Any,
        *,
        endpoint_ids: set[str] | frozenset[str] | None = None,
        model_factory: ModelFactory | None = None,
    ) -> InsightModelResolver:
        """Build resolver defaults from a role registry's public definitions.

        The registry is intentionally duck-typed so this provider layer does
        not import or duplicate role implementation details.  It accepts the
        common ``definitions`` mapping with ``default_model`` values and still
        leaves final allowlist enforcement here.
        """

        defaults: dict[str, str] = {}
        definitions = getattr(registry, "definitions", None)
        if isinstance(definitions, Mapping):
            for role_id, definition in definitions.items():
                default_model = getattr(definition, "default_model", None)
                if isinstance(default_model, str) and default_model.strip():
                    defaults[str(role_id)] = default_model
        return cls(
            settings,
            role_default_models=defaults,
            endpoint_ids=endpoint_ids,
            model_factory=model_factory,
        )

    def __init__(
        self,
        settings: _SettingsLike,
        *,
        role_default_models: Mapping[str, str] | None = None,
        endpoint_ids: set[str] | frozenset[str] | None = None,
        model_factory: ModelFactory | None = None,
    ) -> None:
        self._settings = settings
        configured_role_defaults = _parse_role_defaults(
            getattr(self._settings, "insight_role_default_models", "")
        )
        self._role_default_models = {
            **configured_role_defaults,
            **{
                role_id.strip(): model.strip()
                for role_id, model in (role_default_models or {}).items()
                if role_id.strip() and model.strip()
            },
        }
        configured_endpoint_ids = _split_models(
            getattr(self._settings, "insight_endpoint_ids", DEFAULT_ENDPOINT_ID)
        )
        configured_default_endpoint = getattr(
            self._settings, "insight_default_endpoint_id", DEFAULT_ENDPOINT_ID
        ).strip()
        self._endpoint_ids = frozenset(
            endpoint_ids
            if endpoint_ids is not None
            else configured_endpoint_ids or {configured_default_endpoint}
        )

    def resolve_model(
        self,
        *,
        endpoint_id: str | None = None,
        model_id: str | None = None,
        role_id: str | None = None,
    ) -> InsightModelSelection:
        """Resolve a model from controlled identifiers and server settings."""

        resolved_endpoint = (
            (endpoint_id or self._settings.insight_default_endpoint_id).strip()
        )
        if resolved_endpoint not in self._endpoint_ids:
            raise InsightProviderError(
                InsightProviderErrorCode.ENDPOINT_NOT_ALLOWED,
                "Insight endpoint is not allowed",
                retryable=False,
            )

        if not _provider_is_configured(self._settings):
            raise InsightProviderError(
                InsightProviderErrorCode.PROVIDER_NOT_CONFIGURED,
                "Insight AI provider is not configured",
                retryable=False,
            )

        requested_model = (model_id or "").strip()
        role_default = self._role_default_models.get((role_id or "").strip(), "")
        settings_default = getattr(self._settings, "insight_default_model", "").strip()
        configured_default = (
            settings_default or self._settings.ai_chat_default_model.strip()
        )
        selected_model = requested_model or role_default or configured_default
        if not selected_model:
            raise InsightProviderError(
                InsightProviderErrorCode.MODEL_UNAVAILABLE,
                "Insight model is unavailable",
                retryable=False,
            )

        if selected_model not in self._allowed_models():
            raise InsightProviderError(
                InsightProviderErrorCode.MODEL_NOT_ALLOWED,
                "Insight model is not allowed",
                retryable=False,
            )

        try:
            runtime_model = self._model_factory(selected_model, resolved_endpoint)
        except InsightProviderError:
            raise
        except Exception as exc:
            # Log only non-sensitive classification details.  In particular,
            # do not log settings, provider URLs, exception text, or headers.
            logger.warning(
                "Insight model construction failed: endpoint=%s model=%s error=%s",
                resolved_endpoint,
                selected_model,
                type(exc).__name__,
            )
            raise InsightProviderError(
                InsightProviderErrorCode.MODEL_UNAVAILABLE,
                "Insight model is unavailable",
                retryable=False,
            ) from exc

        return InsightModelSelection(
            endpoint_id=resolved_endpoint,
            model_id=selected_model,
            model=runtime_model,
        )

    def create_agent(
        self,
        selection: InsightModelSelection,
        *,
        role_instructions: Sequence[str] = (),
    ) -> Agent:
        """Create a no-tools Pydantic AI agent for a server-owned role.

        ``role_instructions`` must come from the server-side role registry; a
        request handler must not pass a client ``system_prompt`` through.
        """

        return Agent(
            model=selection.model,
            instructions=list(role_instructions),
            tools=[],
        )

    async def stream_text(
        self,
        agent: _StreamAgent,
        user_prompt: str,
    ) -> AsyncIterator[str]:
        """Yield actual text deltas and classify all provider failures."""

        try:
            async with agent.run_stream(user_prompt) as result:
                async for chunk in result.stream_text(delta=True, debounce_by=None):
                    if isinstance(chunk, str) and chunk:
                        yield chunk
        except InsightProviderError:
            raise
        except Exception as exc:
            raise classify_provider_error(exc) from exc

    def _allowed_models(self) -> set[str]:
        """Build the server-side allowlist and then apply its blocklist."""

        configured = (
            _split_models(self._settings.ai_chat_basic_models)
            | _split_models(self._settings.ai_chat_premium_models)
        )
        default_model = (
            getattr(self._settings, "insight_default_model", "").strip()
            or self._settings.ai_chat_default_model.strip()
        )
        if default_model:
            configured.add(default_model)
        configured.update(self._role_default_models.values())
        blocked = _split_models(self._settings.ai_chat_model_blocklist)
        return {model for model in configured if model not in blocked}

    def _build_openai_model(self, model_id: str, endpoint_id: str) -> OpenAIChatModel:
        if endpoint_id != DEFAULT_ENDPOINT_ID:
            raise InsightProviderError(
                InsightProviderErrorCode.ENDPOINT_NOT_ALLOWED,
                "Insight endpoint is not allowed",
                retryable=False,
            )
        return OpenAIChatModel(
            model_id,
            provider=OpenAIProvider(
                api_key=self._settings.ai_chat_provider_api_key.strip(),
                base_url=_trim_trailing_slash(
                    self._settings.ai_chat_provider_base_url.strip()
                ),
            ),
        )

    @staticmethod
    def _classify_http_error(
        exc: ModelHTTPError | httpx.HTTPStatusError,
    ) -> InsightProviderError:
        if isinstance(exc, ModelHTTPError):
            status_code = exc.status_code
            retry_after_value = exc.retry_after
        else:
            status_code = exc.response.status_code
            retry_after_value = _retry_after_from_headers(exc.response.headers)

        retry_after = (
            max(1, int(retry_after_value))
            if retry_after_value is not None
            else None
        )
        if status_code == 404:
            return InsightProviderError(
                InsightProviderErrorCode.MODEL_UNAVAILABLE,
                "Insight model is unavailable",
                retryable=False,
            )
        if status_code == 429:
            return InsightProviderError(
                InsightProviderErrorCode.UPSTREAM_RATE_LIMITED,
                "Insight provider rate limited the request",
                retryable=True,
                retry_after=retry_after,
            )
        return InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_ERROR,
            "Insight provider returned an upstream error",
            retryable=status_code >= 500,
        )


def classify_provider_error(exc: Exception) -> InsightProviderError:
    """Classify an exception without exposing upstream details."""

    if isinstance(exc, InsightProviderError):
        return exc
    if isinstance(exc, (ModelHTTPError, httpx.HTTPStatusError)):
        return InsightModelResolver._classify_http_error(exc)
    if isinstance(exc, (httpx.TimeoutException, asyncio.TimeoutError)):
        return InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_TIMEOUT,
            "Insight provider request timed out",
            retryable=True,
        )
    if isinstance(exc, (ModelAPIError, httpx.HTTPError)):
        return InsightProviderError(
            InsightProviderErrorCode.UPSTREAM_ERROR,
            "Insight provider request failed",
            retryable=True,
        )
    logger.warning("Insight stream failed: error=%s", type(exc).__name__)
    return InsightProviderError(
        InsightProviderErrorCode.UPSTREAM_ERROR,
        "Insight provider request failed",
        retryable=True,
    )


def _retry_after_from_headers(headers: Mapping[str, str]) -> int | None:
    raw = headers.get("retry-after")
    if raw is None:
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return max(0, value)

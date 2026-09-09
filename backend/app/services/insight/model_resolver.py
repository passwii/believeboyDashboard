"""Public model-resolution facade for canonical Insight runs."""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from pydantic_ai import Agent

from app.services.insight.provider import (
    DEFAULT_ENDPOINT_ID,
    InsightModelResolver,
    InsightModelSelection,
    InsightProviderError,
    InsightProviderErrorCode,
)


def resolve_insight_model(
    settings: Any,
    *,
    endpoint_id: str | None = None,
    model_id: str | None = None,
    role_id: str | None = None,
    role_default_models: Mapping[str, str] | None = None,
) -> InsightModelSelection:
    """Resolve a role/model selection through the server-side policy."""

    return InsightModelResolver(
        settings,
        role_default_models=role_default_models,
    ).resolve_model(
        endpoint_id=endpoint_id,
        model_id=model_id,
        role_id=role_id,
    )


def create_insight_agent(
    selection: InsightModelSelection,
    *,
    role_instructions: Sequence[str] = (),
) -> Agent:
    """Create a no-tools Pydantic AI agent from a resolved selection."""

    return Agent(
        model=selection.model,
        instructions=list(role_instructions),
        tools=[],
    )


__all__ = [
    "DEFAULT_ENDPOINT_ID",
    "InsightModelResolver",
    "InsightModelSelection",
    "InsightProviderError",
    "InsightProviderErrorCode",
    "create_insight_agent",
    "resolve_insight_model",
]

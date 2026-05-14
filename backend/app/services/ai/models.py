from __future__ import annotations

from app.core.config import Settings


def get_blocked_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_model_blocklist.split(",")]
    return {item for item in models if item}


def get_premium_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_premium_models.split(",")]
    return {item for item in models if item}


def get_basic_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_basic_models.split(",")]
    return {item for item in models if item}


def get_reasoning_models(settings: Settings) -> set[str]:
    models = [item.strip() for item in settings.ai_chat_reasoning_models.split(",")]
    return {item for item in models if item}


def normalize_reasoning_effort(value: str | None) -> str | None:
    effort = (value or "").strip().lower()
    if effort in {"low", "medium", "high"}:
        return effort
    return None


def is_provider_configured(settings: Settings) -> bool:
    return bool(
        settings.ai_chat_provider_base_url.strip()
        and settings.ai_chat_provider_api_key.strip()
    )

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE), env_file_encoding="utf-8", extra="ignore"
    )

    app_name: str = "believeboy-backend"
    app_env: str = "development"
    app_host: str = "0.0.0.0"
    app_port: int = 8000

    database_url: str = Field(min_length=1)
    api_key: str = Field(default="change-me", min_length=8)
    ai_chat_provider_base_url: str = Field(default="", max_length=500)
    ai_chat_provider_api_key: str = Field(default="", max_length=500)
    ai_chat_default_model: str = Field(default="", max_length=200)
    ai_chat_title_model: str = Field(default="", max_length=200)
    ai_chat_model_blocklist: str = Field(default="")
    ai_chat_premium_models: str = Field(default="")
    ai_chat_basic_models: str = Field(default="")
    ai_chat_timeout_seconds: int = Field(default=90, ge=10, le=300)
    ai_chat_web_search_base_url: str = Field(
        default="https://search.believeboy.com", max_length=500
    )
    ai_chat_web_search_api_key: str = Field(default="", max_length=500)
    ai_chat_web_search_topic: str = Field(default="general", max_length=50)
    ai_chat_web_search_depth: str = Field(default="advanced", max_length=50)
    ai_chat_web_search_max_results: int = Field(default=5, ge=1, le=10)
    ai_chat_max_conversation_turns: int = Field(default=10, ge=1, le=50)

    upload_root: Path = Path(__file__).resolve().parents[2] / "storage" / "uploads"
    result_root: Path = Path(__file__).resolve().parents[2] / "storage" / "results"

    max_upload_bytes: int = 50 * 1024 * 1024
    allowed_upload_extensions: set[str] = {".txt", ".csv", ".xlsx", ".pdf"}
    allowed_content_types: set[str] = {
        "text/plain",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/pdf",
        "application/octet-stream",
    }

    redis_host: str = Field(default="localhost", max_length=200)
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_password: str = Field(default="", max_length=200)
    redis_db: int = Field(default=0, ge=0, le=15)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)
    return settings

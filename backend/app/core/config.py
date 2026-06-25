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
    app_port: int = 8100

    database_url: str = Field(min_length=1)
    # BEL-55-P5 / BEL-73: optional read-replica URL. When empty, all
    # sessions use `database_url` (backward compatible). When set, the
    # `get_read_db()` dependency opens sessions against this engine and
    # routes SELECTs to it; INSERT/UPDATE/DELETE still go to primary.
    database_read_url: str = Field(default="", max_length=1000)
    db_read_pool_size: int = Field(default=20, ge=1, le=200)
    db_read_max_overflow: int = Field(default=20, ge=0, le=200)
    replica_failure_threshold: int = Field(default=5, ge=1, le=100)
    replica_cooldown_seconds: int = Field(default=30, ge=1, le=600)
    api_key: str = Field(default="change-me", min_length=8)
    ai_chat_provider_base_url: str = Field(default="", max_length=500)
    ai_chat_provider_api_key: str = Field(default="", max_length=500)
    ai_chat_default_model: str = Field(default="", max_length=200)
    ai_chat_backup_model: str = Field(default="", max_length=200)
    ai_chat_title_model: str = Field(default="", max_length=200)
    ai_chat_model_blocklist: str = Field(default="")
    ai_chat_premium_models: str = Field(default="")
    ai_chat_basic_models: str = Field(default="")
    ai_chat_reasoning_models: str = Field(default="")
    ai_chat_default_reasoning_effort: str = Field(default="medium", max_length=20)
    ai_chat_timeout_seconds: int = Field(default=90, ge=10, le=300)
    ai_chat_web_search_base_url: str = Field(
        default="https://search.believeboy.com", max_length=500
    )
    ai_chat_web_search_api_key: str = Field(default="", max_length=500)
    ai_chat_web_search_topic: str = Field(default="general", max_length=50)
    ai_chat_web_search_depth: str = Field(default="advanced", max_length=50)
    ai_chat_web_search_max_results: int = Field(default=20, ge=1, le=100)
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

    # User avatar uploads — separate, smaller cap than generic uploads so
    # we never accept phone-camera dumps into the R2 bucket by accident.
    avatar_max_bytes: int = 5 * 1024 * 1024
    avatar_allowed_extensions: set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    avatar_allowed_content_types: set[str] = {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
    }

    redis_host: str = Field(default="localhost", max_length=200)
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_password: str = Field(default="", max_length=200)
    frontend_url: str = Field(default="", max_length=500)

    resend_api_key: str = Field(default="", max_length=200)
    alert_from_email: str = Field(default="alerts@believeboy.com", max_length=256)
    alert_from_name: str = Field(default="BelieveBoy Dashboard", max_length=128)

    # Scheduled report dispatch
    report_ai_concurrency: int = Field(default=2, ge=1, le=10, description="Max concurrent AI summary API calls during report dispatch")
    max_concurrent_insights: int = Field(default=3, ge=1, le=10, description="Max concurrent AI insight generation tasks")

    redis_db: int = Field(default=0, ge=0, le=15)

    # Celery (auto-derived from REDIS_* when blank)
    celery_broker_url: str = Field(default="", max_length=500)
    celery_result_url: str = Field(default="", max_length=500)
    celery_worker_concurrency: int = Field(default=4, ge=1, le=32)
    # BEL-55-P1 dual-write switch. When true, `job_service.enqueue_job`
    # dispatches via Celery; when false, it falls back to the in-process
    # daemon thread. Flip to false to roll back the Celery migration
    # without redeploying code.
    enable_celery_dispatch: bool = Field(default=True)

    @property
    def _redis_auth_segment(self) -> str:
        """Build `:<password>@` segment for redis URL auth (empty when no password)."""
        if not self.redis_password:
            return ""
        # Use urllib-safe password (avoid leaking special chars into the URL)
        from urllib.parse import quote

        return f":{quote(self.redis_password, safe='')}@"

    @property
    def _celery_broker_url_resolved(self) -> str:
        """Return the effective Celery broker URL (explicit or auto-derived from REDIS_*)."""
        if self.celery_broker_url:
            return self.celery_broker_url
        # Stagger broker DB +1 from business cache to avoid key collisions.
        broker_db = self.redis_db + 1
        return (
            f"redis://{self._redis_auth_segment}"
            f"{self.redis_host}:{self.redis_port}/{broker_db}"
        )

    @property
    def _celery_result_url_resolved(self) -> str:
        """Return the effective Celery result backend URL (explicit or auto-derived)."""
        if self.celery_result_url:
            return self.celery_result_url
        # Result backend sits on broker_db +1 to stay separate from broker traffic.
        result_db = self.redis_db + 2
        return (
            f"redis://{self._redis_auth_segment}"
            f"{self.redis_host}:{self.redis_port}/{result_db}"
        )

    # Cloudflare R2 Storage
    r2_account_id: str = Field(default="", max_length=100)
    r2_endpoint_url: str = Field(default="", max_length=500)
    r2_public_url: str = Field(default="", max_length=500)
    r2_access_key_id: str = Field(default="", max_length=100)
    r2_secret_access_key: str = Field(default="", max_length=200)
    r2_bucket_name: str = Field(default="", max_length=100)
    r2_region: str = Field(default="auto", max_length=50)

    @property
    def r2_enabled(self) -> bool:
        """Check if R2 is properly configured."""
        return bool(self.r2_endpoint_url and self.r2_access_key_id and self.r2_secret_access_key and self.r2_bucket_name)

    @property
    def replica_enabled(self) -> bool:
        """True when a read-replica URL is configured (BEL-55-P5 / BEL-73).

        Used by health endpoint, startup probe, and tests to decide
        whether the read-routing path is live.
        """
        return bool(self.database_read_url)


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)
    return settings

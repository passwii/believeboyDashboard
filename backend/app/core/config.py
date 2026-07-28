from functools import lru_cache
from pathlib import Path

from pydantic import Field, model_validator
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

    database_url: str = Field(default="")
    # BEL-55-P5 / BEL-73: optional read-replica URL. When empty, all
    # sessions use `database_url` (backward compatible). When set, the
    # `get_read_db()` dependency opens sessions against this engine and
    # routes SELECTs to it; INSERT/UPDATE/DELETE still go to primary.
    database_read_url: str = Field(default="", max_length=1000)

    # ------------------------------------------------------------------
    # Dedicated test database (BEL: test isolation).
    # When TEST_DATABASE_URL is set, the app, alembic migrations, and the
    # whole test suite transparently use this DB instead of `database_url`,
    # so tests never touch the dev/prod database. The test DB is a separate
    # persistent Postgres database, created + migrated + seeded once via
    # `python scripts/setup_test_db.py` (see AGENTS.md / .env.example).
    # ------------------------------------------------------------------
    test_database_url: str = Field(default="", max_length=1000)
    test_database_read_url: str = Field(default="", max_length=1000)

    # Test accounts seeded into the test DB by `scripts/seed_test_accounts.py`.
    # Emails have safe defaults; passwords must come from env (never committed)
    # — see TEST_*_PASSWORD below. These mirror the accounts the agent/E2E
    # test suites authenticate as.
    test_admin_email: str = Field(default="test_admin@believeboy.com", max_length=320)
    test_operator_email: str = Field(
        default="test_operator@believeboy.com", max_length=320
    )
    test_businessdev_email: str = Field(
        default="test_businessdev@believeboy.com", max_length=320
    )
    test_admin_password: str = Field(default="", max_length=256)
    test_operator_password: str = Field(default="", max_length=256)
    test_businessdev_password: str = Field(default="", max_length=256)
    db_read_pool_size: int = Field(default=20, ge=1, le=200)
    db_read_max_overflow: int = Field(default=20, ge=0, le=200)
    replica_failure_threshold: int = Field(default=5, ge=1, le=100)
    replica_cooldown_seconds: int = Field(default=30, ge=1, le=600)
    api_key: str = Field(default="change-me", min_length=8)
    internal_ingest_token: str = Field(default="", min_length=0, max_length=256)
    ai_chat_provider_base_url: str = Field(default="", max_length=500)
    ai_chat_provider_api_key: str = Field(default="", max_length=500)
    ai_chat_default_model: str = Field(default="", max_length=200)
    ai_chat_backup_model: str = Field(default="", max_length=200)
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

    # Markdown / HTML page rendering (特殊功能) — uploaded files are stored
    # publicly in R2 and served back as standalone pages at `/p/{id}`.
    # Cap is small because md/html pages are tiny by nature; this also keeps
    # the public-bucket blast radius bounded.
    page_render_allowed_extensions: set[str] = {".md", ".markdown", ".html", ".htm"}
    page_render_allowed_content_types: set[str] = {
        "text/markdown",
        "text/x-markdown",
        "text/html",
        "text/plain",
        "application/octet-stream",
    }
    page_render_max_bytes: int = 2 * 1024 * 1024  # 2 MB
    page_render_public_rate_limit: str = "30/minute"  # public read endpoint limit

    redis_host: str = Field(default="localhost", max_length=200)
    redis_port: int = Field(default=6379, ge=1, le=65535)
    redis_password: str = Field(default="", max_length=200)
    frontend_url: str = Field(default="http://localhost:3200", max_length=500)

    resend_api_key: str = Field(default="", max_length=200)
    alert_from_email: str = Field(default="alerts@believeboy.com", max_length=256)
    alert_from_name: str = Field(default="BelieveBoy Dashboard", max_length=128)

    # Scheduled report dispatch
    report_ai_concurrency: int = Field(
        default=2,
        ge=1,
        le=10,
        description="Max concurrent AI summary API calls during report dispatch",
    )
    max_concurrent_insights: int = Field(
        default=3, ge=1, le=10, description="Max concurrent AI insight generation tasks"
    )

    # BEL-NEW: 定时报告迁移至 Celery worker (方案 docs/superpowers/plans/2026-07-10-scheduled-report-to-celery.md)
    # ENABLE_SCHEDULER=false 时本 API 进程不启动 APScheduler（多副本时仅一个副本设 true）。
    enable_scheduler: bool = Field(default=True)
    # SCHEDULED_REPORT_VIA_CELERY=true 时 APScheduler 触发走 delay() 进 Worker；
    # false 时退回 ThreadPoolExecutor 在 API 内同步跑（回滚形态，不动代码）。
    scheduled_report_via_celery: bool = Field(default=True)
    # 同一分钟触发的多个订阅，第 i 个延迟 i×SPREAD 秒错峰派发。
    scheduled_dispatch_spread_seconds: int = Field(default=60, ge=0, le=600)
    # ai_summary 队列的 LLM 并发信号量上限（与 insights 独立）。方案 §4.6 取 5：
    #   insights 占 3 路，ai_summary 额外允许 5 路，留 headroom 不撞 LLM RPM。
    max_concurrent_ai_summary: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Max concurrent AI summary tasks on ai_summary queue (separate semaphore from insights).",
    )

    redis_db: int = Field(default=0, ge=0, le=15)

    # AI Chat stream(Redis Stream + cancel registry)
    ai_chat_redis_db: int = Field(default=3, ge=0, le=15)
    ai_chat_stream_prefix: str = Field(default="ai:chat", max_length=50)
    ai_chat_stream_ttl_seconds: int = Field(default=86400, ge=60, le=604800)  # 24h
    ai_chat_stream_maxlen: int = Field(default=10000, ge=100, le=100000)

    # Celery (auto-derived from REDIS_* when blank)
    celery_broker_url: str = Field(default="", max_length=500)
    celery_result_url: str = Field(default="", max_length=500)
    celery_worker_concurrency: int = Field(default=2, ge=1, le=32)
    # CRM 公海自动回收（P3a）：有主但超过 N 天未跟进的客户/线索自动掉公海。
    # 0 = 关闭自动回收。环境变量 CRM_SEA_RECLAIM_DAYS 可调。
    crm_sea_reclaim_days: int = Field(default=15, ge=0, le=365)
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

    # --- PostgreSQL Backup (via pgBackRest → R2) ---------------------------
    # Plan: docs/superpowers/plans/2026-07-17-pg-r2-backup-feature/
    # true  = API 端只 enqueue, Celery worker 跑 (新形态, §3.1 P0-1)
    # false = API 端同步 subprocess.run (旧形态, 回滚兜底, §Phase 6)
    backup_via_celery: bool = Field(default=True)

    @property
    def r2_enabled(self) -> bool:
        """Check if R2 is properly configured."""
        return bool(
            self.r2_endpoint_url
            and self.r2_access_key_id
            and self.r2_secret_access_key
            and self.r2_bucket_name
        )

    @property
    def replica_enabled(self) -> bool:
        """True when a read-replica URL is configured (BEL-55-P5 / BEL-73).

        Used by health endpoint, startup probe, and tests to decide
        whether the read-routing path is live.
        """
        return bool(self.database_read_url)

    @model_validator(mode="after")
    def _apply_test_database_override(self) -> "Settings":
        """Point the app at the dedicated test DB when TEST_DATABASE_URL is set.

        This makes `database_url` / `database_read_url` (and thus the SQLAlchemy
        engine in `app.db.session`, alembic migrations, and every test) resolve
        to the test database without any code changes at the call sites.
        """
        if self.test_database_url:
            self.database_url = self.test_database_url
        if self.test_database_read_url:
            self.database_read_url = self.test_database_read_url
        if not self.database_url:
            raise ValueError(
                "database_url is required: set DATABASE_URL, or TEST_DATABASE_URL "
                "to route the app/tests at a separate test database."
            )
        return self


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)
    return settings

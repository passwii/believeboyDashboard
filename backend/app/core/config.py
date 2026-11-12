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
    # `cd backend-go && go run ./cmd/setuptestdb` (see AGENTS.md / .env.example).
    # ------------------------------------------------------------------
    test_database_url: str = Field(default="", max_length=1000)
    test_database_read_url: str = Field(default="", max_length=1000)

    # Test accounts seeded into the test DB by `backend-go/cmd/seedtestaccounts`.
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
    db_pool_size: int = Field(default=5, ge=1, le=50)
    db_max_overflow: int = Field(default=5, ge=0, le=50)
    db_read_pool_size: int = Field(default=5, ge=1, le=50)
    db_read_max_overflow: int = Field(default=5, ge=0, le=50)
    replica_failure_threshold: int = Field(default=5, ge=1, le=100)
    replica_cooldown_seconds: int = Field(default=30, ge=1, le=600)
    # BLF-1262 Stage 1：order-info 只读端点（page/list/stats/overview/
    # filter-options/live-stream）的**单语句** statement_timeout 预算（毫秒）。
    # 全局兜底仍是 connect_args 里的 120s（见 app/db/session.py）——这里只是把
    # 「前端代理早已 abort、后端线程却还在跑」的重型查询钉在更紧的预算上，
    # 超时由 Postgres 主动取消并立刻归还连接，而不是让它占满 120s。
    # 取 15s 的理由：为 order-info/filter-options 等只读查询设置明确的单语句预算；
    # Next.js 代理侧 20s order-info-read 档只为后端返回预留尽力而为的传递余量，
    # 并非严格请求级 deadline（多条 SQL 累计耗时仍可能超过代理上限）。
    # 上限锁 120s = 全局值，避免有人把它调成比全局兜底还宽而误以为"没生效"。
    order_info_statement_timeout_ms: int = Field(default=15_000, ge=1_000, le=120_000)
    api_key: str = Field(default="change-me", min_length=8)
    internal_ingest_token: str = Field(default="", min_length=0, max_length=256)

    # ------------------------------------------------------------------
    # External API P1 (BEL-377): application-layer auth / rate-limit / audit
    # for the ``/api/v1/external/*`` namespace.
    #
    # Both enforcement flags default to OFF so deploying this code is a
    # no-op for existing consumers (P0 had no app-layer auth; network
    # isolation at the gateway is the backstop). Flip them on once every
    # consumer holds a key from ``POST /api/v1/internal/api-keys``.
    # ------------------------------------------------------------------
    # Master switch: require a valid API key on every external route.
    external_api_require_auth: bool = Field(default=False)
    # Transition helper: while enforced, honour ``?skip_auth=true`` so
    # stragglers keep working. Remove the bypass after the rollout window.
    external_api_allow_skip_auth: bool = Field(default=True)
    # Per-key (or per-IP fallback) rate limiting via slowapi.
    external_api_rate_limit_enabled: bool = Field(default=False)
    external_api_rate_limit: str = Field(default="60/minute", max_length=32)
    # Agent API 访问审计（仅 /api/v1/agent/*；/external/* 已于 BLF-459 V3 下线）。
    agent_api_audit_enabled: bool = Field(default=True)
    # 访问审计保留天数（Celery 清理任务）。
    agent_api_audit_retention_days: int = Field(default=90, ge=1, le=3650)
    # 操作审计（agent 写操作明细）保留天数（BLF-460；仅清 agent 行）。
    operation_audit_retention_days: int = Field(default=90, ge=1, le=3650)
    # Agent 通道限流（slowapi 内存 Limiter）：读桶挂命名空间级，写桶由 P2 写路由逐个挂载。
    # 设计稿 §7.1：可不改代码调整。
    agent_api_read_rate_limit: str = Field(default="300/minute", max_length=32)
    # 写桶 120/min（BLF-782）：原 30/min 在 agent 批量录入场景易触顶；写操作
    # 全量落 operation_audit_logs 可追溯，按 agent_id 独立计数，放宽风险可控。
    agent_api_write_rate_limit: str = Field(default="120/minute", max_length=32)
    # Canonical Insight provider selection remains server-side.  Clients may
    # submit only ids from this registry; credentials and URLs never leave the
    # backend process.
    insight_default_endpoint_id: str = Field(default="default", max_length=64)
    insight_endpoint_ids: str = Field(default="default", max_length=500)
    insight_default_model: str = Field(default="", max_length=200)
    insight_role_default_models: str = Field(default="", max_length=2000)
    # Insight 可用模型是否并入「供应商现役模型清单」（代理 /v1/models，带 TTL
    # 缓存）。默认开：UI 下拉与 chat 链路都取自该清单，Insight 若只认静态
    # AI_CHAT_* 清单就会与其漂移，把用户在下拉里选得到的模型判成
    # MODEL_NOT_ALLOWED（生产：订阅预设 GPT-5.6-Luna 被误判）。置 False 回退静态
    # allowlist（回滚开关）；拉取失败时也自动回退，不放大可用集合。
    insight_allow_provider_models: bool = Field(default=True)
    # BLF-1016 可逆开关：逗号分隔的域 role 白名单（ad_analysis,
    # inventory_health）。为空 = 旧链路唯一写端；列入的域改为 canonical
    # Insight 写入，并冻结旧 AIInsight 写端点（不双写）。回滚只需清空。
    insight_canonical_domains: str = Field(default="", max_length=200)
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
    # Agent 月报写入流程（BLF-1250 阶段一）：临时上传与仅计算草稿的私有根目录。
    # 与 upload_root / result_root 分开，因为这里的文件是「未确认临时件」——
    # confirm 成功后才会晋升（复制）到正式目录，失败/过期由 janitor 删除。
    agent_monthly_report_root: Path = (
        Path(__file__).resolve().parents[2] / "storage" / "agent_monthly_reports"
    )
    # 用户 2026-10-06 确认的产品规则：每个 CSV/PDF 上限 50 MiB。服务端按流累计
    # 字节拦截，不只信 Content-Length（见 agent_monthly_report_upload_service）。
    agent_monthly_report_max_bytes: int = 50 * 1024 * 1024
    # 未确认输入与结果保留 24 小时；到期不可 build/confirm，由 janitor 清理。
    agent_monthly_report_ttl_hours: int = 24
    # build 执行硬超时（分钟）：必须大于 celery 硬超时（run_job 为 20 分钟），
    # 否则 janitor 会把仍在计算的任务判死。超时后 running 状态由 janitor 恢复为
    # failed 并清理目录，避免状态永远 running 导致永不清理。
    agent_monthly_report_build_timeout_minutes: int = 25

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

    # 项目启动台节点附件（P2 / BLF-1237）——内务回传，单独一套允许面：
    # 报表上传是「固定业务类型 + 固定格式」，附件是「内务留档，含打包 zip 与图片」，
    # 两者混用会让报表侧意外放宽，所以不复用 allowed_upload_extensions。
    workflow_attachment_max_bytes: int = 50 * 1024 * 1024
    workflow_attachment_allowed_extensions: set[str] = {
        ".pdf",
        ".xlsx",
        ".xls",
        ".docx",
        ".doc",
        ".csv",
        ".txt",
        ".zip",
        ".png",
        ".jpg",
        ".jpeg",
        ".webp",
    }
    workflow_attachment_allowed_content_types: set[str] = {
        "text/plain",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/pdf",
        "application/octet-stream",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/msword",
        "application/zip",
        "application/x-zip-compressed",
        "image/png",
        "image/jpeg",
        "image/webp",
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
    # 客户方案单个 HTML 上传上限（含内联 base64 图/样式的自包含文档，可比
    # page_render 的 2MB 放宽）；见 services/crm/proposal_service.py。
    crm_proposal_max_bytes: int = 20 * 1024 * 1024  # 20 MB

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
    # 全局 Redis key 前缀，避免多应用共享 Redis 时 key 碰撞。
    # 所有业务 key 统一为 "{prefix}:{domain}:..." 格式。
    redis_key_prefix: str = Field(default="bb", max_length=20)

    # AI Chat stream(Redis Stream + cancel registry)
    ai_chat_redis_db: int = Field(default=3, ge=0, le=15)
    ai_chat_stream_prefix: str = Field(default="ai:chat", max_length=50)
    ai_chat_stream_ttl_seconds: int = Field(default=86400, ge=60, le=604800)  # 24h
    ai_chat_stream_maxlen: int = Field(default=10000, ge=100, le=100000)
    # Insight Stream(Redis Stream + cancel registry,BLF-1012)
    # 独立 db(4)避免与业务缓存/Celery broker/Celery result/AI Chat 相互污染。
    insight_stream_redis_db: int = Field(default=4, ge=0, le=15)
    insight_stream_ttl_seconds: int = Field(default=86400, ge=60, le=604800)  # 24h
    insight_stream_maxlen: int = Field(default=10000, ge=100, le=100000)

    # ── BLF-1018 观测期（Stage 5）────────────────────────────────────────
    # 指标写入开关：False = 停写 insight_run_observations（聚合接口退化为
    # 「无观测数据」），run 本身照常执行。观测期出问题时的回滚开关。
    insight_observation_enabled: bool = Field(default=True)
    # 聚合接口默认窗口：只统计最近 N 天的观测行。
    insight_observation_window_days: int = Field(default=7, ge=1, le=90)
    # 门禁阈值。默认值一律锚定仓库既有数字，不新造经验值：
    #   300_000ms = celery_tasks/insights/run.py 的 soft_time_limit=300（执行器预算）；
    #   90_000ms  = ai_chat_timeout_seconds 默认 90s（provider 调用预算，首字不会晚于它）；
    #   10_000    = insight_stream_maxlen（超了说明保留窗口正在滚出，续传会退化）。
    # 0 = 该项不判定（只报数不给结论），供运维按需收紧。
    insight_gate_max_duration_ms: int = Field(default=300_000, ge=0)
    insight_gate_max_first_delta_ms: int = Field(default=90_000, ge=0)
    insight_gate_max_stream_frames: int = Field(default=10_000, ge=0)
    # canonical 域（由 Insight 服务的桶）降级比例上限：0.0 = 不判定（只报数）。
    # 要表达「不允许降级」请配一个正的下限（如 0.0001），让 0 专管「不判定」
    # 这一个含义 —— 见 INSIGHT_OBSERVATION_GATE.md §2.1。
    insight_gate_max_fallback_ratio: float = Field(default=0.0, ge=0.0, le=1.0)
    # 成本异常判定倍数：单 run token 超过桶内中位数的 N 倍即异常（样本 >= 3）。
    # 这是运维经验默认（不是仓库既有数字），按需调整；比例判定不依赖模型单价。
    insight_gate_cost_anomaly_multiplier: float = Field(default=5.0, ge=0.0)
    # 抢 insights 并发槽的最长等待（秒）：饱和即回退重排队，绝不在闸门上
    # 耗掉 soft_time_limit（300s）。
    insight_semaphore_wait_seconds: int = Field(default=60, ge=0, le=280)

    # Celery (auto-derived from REDIS_* when blank)
    celery_broker_url: str = Field(default="", max_length=500)
    celery_result_url: str = Field(default="", max_length=500)
    celery_worker_concurrency: int = Field(default=1, ge=1, le=32)
    # CRM 公海自动回收（P3a）：有主但超过 N 天未跟进的客户/线索自动掉公海。
    # 0 = 关闭自动回收。环境变量 CRM_SEA_RECLAIM_DAYS 可调。
    crm_sea_reclaim_days: int = Field(default=15, ge=0, le=365)
    # CRM 7 天无跟进提醒（P9-1, BLF-539）：超过 N 天未跟进的客户/线索触发站内提醒。
    # 0 = 关闭提醒。环境变量 CRM_FOLLOW_UP_REMINDER_DAYS 可调。
    crm_follow_up_reminder_days: int = Field(default=7, ge=0, le=365)
    # CRM 规则引擎执行器（P9-6, BLF-544）：全局开关（False = 停扫规则；
    # 规则级启停仍由 crm_rules.enabled 控制）。环境变量 CRM_RULE_ENGINE_ENABLED 可调。
    crm_rule_engine_enabled: bool = Field(default=True)

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

    @model_validator(mode="after")
    def _validate_redis_db_no_collision(self) -> "Settings":
        """确保业务缓存 / Celery broker / Celery result / AI Chat / Insight 五个 Redis DB 互不碰撞。

        Celery broker = redis_db+1, result = redis_db+2（自动派生）。
        ai_chat_redis_db / insight_stream_redis_db 是独立配置。五者必须互不相同。
        """
        celery_broker_db = self.redis_db + 1
        celery_result_db = self.redis_db + 2
        used = {
            "redis_db (业务缓存)": self.redis_db,
            "celery_broker (redis_db+1)": celery_broker_db,
            "celery_result (redis_db+2)": celery_result_db,
            "ai_chat_redis_db": self.ai_chat_redis_db,
            "insight_stream_redis_db": self.insight_stream_redis_db,
        }
        seen: dict[int, str] = {}
        for label, db in used.items():
            if db in seen:
                raise ValueError(
                    f"Redis DB 碰撞: {label}={db} 与 {seen[db]}={db} 相同。"
                    f"请调整 REDIS_DB / AI_CHAT_REDIS_DB / INSIGHT_STREAM_REDIS_DB 避免冲突。"
                )
            seen[db] = label
        return self


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.upload_root.mkdir(parents=True, exist_ok=True)
    settings.result_root.mkdir(parents=True, exist_ok=True)
    settings.agent_monthly_report_root.mkdir(parents=True, exist_ok=True)
    return settings

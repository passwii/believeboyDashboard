"""Insight Stage 1 canonical contract：请求/响应/detail/typed error。

独立命名空间 `insight`，不复用旧 `ai_insight.py` 业务 DTO。
已冻结模型统一 `extra="forbid"`；wire 破坏性变更必须升 `schema_version`。
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import (
    UUID4,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    PositiveInt,
    field_validator,
    model_validator,
)

SchemaVersion = Literal[1]

CountryCode = Literal["US", "DE", "UK"]

OutputFormat = Literal["markdown"]

#: 客户端不得提交的 prompt/secret 键；system_prompt/instructions 映射专用错误码
SYSTEM_PROMPT_KEYS = ("system_prompt", "instructions")
FORBIDDEN_CLIENT_KEYS = ("system_prompt", "instructions", "api_key", "base_url", "provider_url")

#: 幂等 key / 受控标识正则（与 limits.py 保持一致，schema 侧做第一道拦截）
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9._:-]{1,64}$"
CONTROLLED_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,63}$"
#: model_id 承载供应商真实模型名（大小写敏感，见 limits.MODEL_ID_PATTERN）
MODEL_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$"

#: 输出内容摘要：小写 SHA-256 hex
SHA256_HEX_PATTERN = r"^[0-9a-f]{64}$"

#: 递归 JSON 值（slot 原始载荷在 request 侧的泛型表示；细校验由 registry TypeAdapter 做）
type JsonValue = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]

_FROZEN = ConfigDict(extra="forbid")


class InsightStatus(str, Enum):
    QUEUED = "queued"
    AGGREGATING = "aggregating"
    GENERATING = "generating"
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class InsightStage(str, Enum):
    QUEUED = "queued"
    AGGREGATING = "aggregating"
    GENERATING = "generating"
    FINALIZING = "finalizing"


class InsightErrorCode(str, Enum):
    INVALID_REQUEST = "INVALID_REQUEST"
    UNKNOWN_ROLE = "UNKNOWN_ROLE"
    ROLE_VERSION_UNSUPPORTED = "ROLE_VERSION_UNSUPPORTED"
    ROLE_NOT_AVAILABLE = "ROLE_NOT_AVAILABLE"
    UNKNOWN_SLOT = "UNKNOWN_SLOT"
    MISSING_REQUIRED_SLOT = "MISSING_REQUIRED_SLOT"
    SLOT_VALIDATION_FAILED = "SLOT_VALIDATION_FAILED"
    SCOPE_MISMATCH = "SCOPE_MISMATCH"
    PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND"
    PROJECT_OUT_OF_SCOPE = "PROJECT_OUT_OF_SCOPE"
    COUNTRY_MISMATCH = "COUNTRY_MISMATCH"
    REQUEST_TOO_LARGE = "REQUEST_TOO_LARGE"
    SLOT_TOO_LARGE = "SLOT_TOO_LARGE"
    SYSTEM_PROMPT_NOT_ALLOWED = "SYSTEM_PROMPT_NOT_ALLOWED"
    IDEMPOTENCY_KEY_REQUIRED = "IDEMPOTENCY_KEY_REQUIRED"
    IDEMPOTENCY_KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT"
    RUN_NOT_FOUND = "RUN_NOT_FOUND"
    RUN_TERMINAL = "RUN_TERMINAL"
    INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION"
    RESUME_CURSOR_INVALID = "RESUME_CURSOR_INVALID"
    MODEL_NOT_ALLOWED = "MODEL_NOT_ALLOWED"
    RATE_LIMITED = "RATE_LIMITED"
    PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
    UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT"
    CONTENT_FILTERED = "CONTENT_FILTERED"
    CANCELLED = "CANCELLED"


#: 错误码 → HTTP 状态固定映射
ERROR_HTTP_STATUS: dict[InsightErrorCode, int] = {
    InsightErrorCode.INVALID_REQUEST: 422,
    InsightErrorCode.UNKNOWN_ROLE: 422,
    InsightErrorCode.ROLE_VERSION_UNSUPPORTED: 422,
    InsightErrorCode.ROLE_NOT_AVAILABLE: 422,
    InsightErrorCode.UNKNOWN_SLOT: 422,
    InsightErrorCode.MISSING_REQUIRED_SLOT: 422,
    InsightErrorCode.SLOT_VALIDATION_FAILED: 422,
    InsightErrorCode.SCOPE_MISMATCH: 422,
    InsightErrorCode.PROJECT_NOT_FOUND: 404,
    InsightErrorCode.PROJECT_OUT_OF_SCOPE: 403,
    InsightErrorCode.COUNTRY_MISMATCH: 422,
    InsightErrorCode.REQUEST_TOO_LARGE: 413,
    InsightErrorCode.SLOT_TOO_LARGE: 413,
    InsightErrorCode.SYSTEM_PROMPT_NOT_ALLOWED: 422,
    InsightErrorCode.IDEMPOTENCY_KEY_REQUIRED: 422,
    InsightErrorCode.IDEMPOTENCY_KEY_CONFLICT: 409,
    InsightErrorCode.RUN_NOT_FOUND: 404,
    InsightErrorCode.RUN_TERMINAL: 409,
    InsightErrorCode.INVALID_STATE_TRANSITION: 409,
    InsightErrorCode.RESUME_CURSOR_INVALID: 400,
    InsightErrorCode.MODEL_NOT_ALLOWED: 422,
    InsightErrorCode.RATE_LIMITED: 429,
    InsightErrorCode.PROVIDER_UNAVAILABLE: 503,
    InsightErrorCode.UPSTREAM_TIMEOUT: 504,
    InsightErrorCode.CONTENT_FILTERED: 422,
    InsightErrorCode.CANCELLED: 409,
}

#: 默认可重试的错误码（其余一律不可重试）
RETRYABLE_ERROR_CODES = frozenset(
    {
        InsightErrorCode.RATE_LIMITED,
        InsightErrorCode.PROVIDER_UNAVAILABLE,
        InsightErrorCode.UPSTREAM_TIMEOUT,
    }
)


class InsightError(BaseModel):
    """Typed error：payload 绝不携带异常原文、上游响应、URL、凭据或 system policy."""

    model_config = _FROZEN

    code: InsightErrorCode
    message: str = Field(min_length=1)
    retryable: bool = False
    retry_after_seconds: Annotated[int, Field(ge=0)] | None = None
    partial_available: bool = False
    field: str | None = None
    slot: str | None = None
    details: dict[str, JsonValue] | None = None


def make_error(
    code: InsightErrorCode,
    message: str,
    *,
    retryable: bool | None = None,
    retry_after_seconds: int | None = None,
    partial_available: bool = False,
    field: str | None = None,
    slot: str | None = None,
    details: dict[str, Any] | None = None,
) -> InsightError:
    """构造 typed error：retryable 缺省按码表回填。"""
    if retryable is None:
        retryable = code in RETRYABLE_ERROR_CODES
    return InsightError(
        code=code,
        message=message,
        retryable=retryable,
        retry_after_seconds=retry_after_seconds,
        partial_available=partial_available,
        field=field,
        slot=slot,
        details=details,
    )


class InsightErrorResponse(BaseModel):
    model_config = _FROZEN

    schema_version: SchemaVersion
    run_id: UUID4 | None = None
    error: InsightError


class InsightScope(BaseModel):
    """请求 scope：权限校验由独立 validator 调既有项目权限服务。"""

    model_config = _FROZEN

    project_id: PositiveInt
    country: CountryCode


class InsightRoleRef(BaseModel):
    model_config = _FROZEN

    role_id: str = Field(min_length=1, max_length=128)
    role_version: PositiveInt

    @property
    def canonical_key(self) -> str:
        return f"{self.role_id}.v{self.role_version}"


class InsightRunRequest(BaseModel):
    """创建 run 请求。`output_format` 由服务端固定，客户端不可覆盖。"""

    model_config = _FROZEN

    schema_version: SchemaVersion
    role_id: str = Field(min_length=1, max_length=128)
    role_version: PositiveInt
    project_id: PositiveInt
    country: CountryCode
    slots: dict[str, JsonValue]
    idempotency_key: str = Field(min_length=1, max_length=64, pattern=IDEMPOTENCY_KEY_PATTERN)
    client_request_id: UUID4 | None = None
    endpoint_id: Annotated[str, Field(pattern=CONTROLLED_ID_PATTERN)] | None = None
    model_id: Annotated[str, Field(pattern=MODEL_ID_PATTERN)] | None = None

    @model_validator(mode="before")
    @classmethod
    def _reject_prompt_keys(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key in SYSTEM_PROMPT_KEYS:
                if key in data:
                    raise ValueError("SYSTEM_PROMPT_NOT_ALLOWED: client must not submit system prompt")
        return data

    @field_validator("idempotency_key")
    @classmethod
    def _strip_key(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("IDEMPOTENCY_KEY_REQUIRED: idempotency_key must not be blank")
        return v


class InsightRunResponse(BaseModel):
    """创建 run 响应。不回显 key / URL / prompt，只给相对本产品 URL。"""

    model_config = _FROZEN

    schema_version: SchemaVersion
    run_id: UUID4
    attempt: PositiveInt
    role_id: str
    role_version: PositiveInt
    project_id: PositiveInt
    country: CountryCode
    status: InsightStatus
    output_format: OutputFormat = "markdown"
    detail_url: str
    stream_url: str
    cancel_url: str
    retry_url: str
    replayed: bool = False
    created_at: AwareDatetime
    updated_at: AwareDatetime


class InsightUsage(BaseModel):
    model_config = _FROZEN

    input_tokens: Annotated[int, Field(ge=0)]
    output_tokens: Annotated[int, Field(ge=0)]
    total_tokens: Annotated[int, Field(ge=0)]


class InsightOutput(BaseModel):
    """输出 slot：Markdown artifact + 小写 SHA-256 digest。"""

    model_config = _FROZEN

    format: OutputFormat = "markdown"
    content: str = Field(min_length=1)
    content_sha256: str = Field(pattern=SHA256_HEX_PATTERN)


class InsightResumeInfo(BaseModel):
    """canonical cursor 可恢复性描述；不暴露 Redis entry / DB key / provider 信息。"""

    model_config = _FROZEN

    latest_event_id: str | None = None
    current_attempt: PositiveInt
    history_available: bool


class InsightRunDetail(BaseModel):
    """权威 detail：页面重开、SSE 过期、后台完成后均可读取。"""

    model_config = _FROZEN

    schema_version: SchemaVersion
    run_id: UUID4
    attempt: PositiveInt
    role_id: str
    role_version: PositiveInt
    project_id: PositiveInt
    country: CountryCode
    status: InsightStatus
    stage: InsightStage
    progress_percent: Annotated[int, Field(ge=0, le=100)]
    output_format: OutputFormat = "markdown"
    title: str | None = None
    outputs: dict[str, InsightOutput] = Field(default_factory=dict)
    artifact_id: str | None = None
    usage: InsightUsage | None = None
    error: InsightError | None = None
    resume: InsightResumeInfo
    created_at: AwareDatetime
    started_at: AwareDatetime | None = None
    completed_at: AwareDatetime | None = None
    updated_at: AwareDatetime


class InsightRunActionResponse(BaseModel):
    """cancel / retry 动作响应。"""

    model_config = _FROZEN

    schema_version: SchemaVersion
    run_id: UUID4
    attempt: PositiveInt
    status: InsightStatus
    detail_url: str
    stream_url: str
    replayed: bool = False


class InsightStatusDetail(BaseModel):
    """status 事件业务载荷（不含 envelope）：安全展示文本至多 512 字符。"""

    model_config = _FROZEN

    status: InsightStatus
    stage: InsightStage
    progress_percent: Annotated[int, Field(ge=0, le=100)]
    detail: Annotated[str, Field(max_length=512)] | None = None

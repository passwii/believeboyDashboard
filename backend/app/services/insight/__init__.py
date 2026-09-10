"""Insight 服务层：Stage 1 纯 Pydantic 合同/注册表/验证器/生命周期 + server 侧 provider。

合同层不 import FastAPI、Redis、Celery 或旧 AIInsight；
provider 层拥有 server 侧凭证边界，绝不进入 response/audit payload。
BLF-1011 新增 durable run 仓储（runs）与 Celery 执行器（executor）；
两者均不 import Celery/Redis/HTTP，transport 由 BLF-1012 接入。
"""

from app.services.insight.contracts import (
    serialize_contract,
    sha256_hex,
    to_canonical_json,
)
from app.services.insight.model_resolver import (
    create_insight_agent,
    resolve_insight_model,
)
from app.services.insight.provider import (
    DEFAULT_ENDPOINT_ID,
    InsightModelResolver,
    InsightModelSelection,
    InsightProviderError,
    InsightProviderErrorCode,
    classify_provider_error,
)
from app.services.insight.executor import (
    EnqueueFunc,
    GenerateFunc,
    InsightEventSink,
    LLMResult,
    ListEventSink,
    ModelResolverFunc,
    NullEventSink,
    PromptBuilder,
    RetryableFailure,
    execute_run,
    is_retryable,
    map_provider_error,
    start_run,
)
from app.services.insight.runs import (
    IdempotencyConflict,
    RunNotFound,
    cancel_run,
    create_run,
    get_run,
    get_run_for_update,
    retry_run,
    to_detail,
    transition,
)

__all__ = [
    "DEFAULT_ENDPOINT_ID",
    "EnqueueFunc",
    "GenerateFunc",
    "IdempotencyConflict",
    "InsightEventSink",
    "InsightModelResolver",
    "InsightModelSelection",
    "InsightProviderError",
    "InsightProviderErrorCode",
    "LLMResult",
    "ListEventSink",
    "ModelResolverFunc",
    "NullEventSink",
    "PromptBuilder",
    "RetryableFailure",
    "RunNotFound",
    "cancel_run",
    "classify_provider_error",
    "create_insight_agent",
    "create_run",
    "execute_run",
    "get_run",
    "get_run_for_update",
    "is_retryable",
    "map_provider_error",
    "resolve_insight_model",
    "retry_run",
    "serialize_contract",
    "sha256_hex",
    "start_run",
    "to_canonical_json",
    "to_detail",
    "transition",
]

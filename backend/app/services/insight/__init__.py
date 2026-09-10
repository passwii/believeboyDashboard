"""Insight 服务层：Stage 1 纯 Pydantic 合同/注册表/验证器/生命周期 + server 侧 provider。

合同层不 import FastAPI、Redis、Celery 或旧 AIInsight；
provider 层拥有 server 侧凭证边界，绝不进入 response/audit payload。
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

__all__ = [
    "DEFAULT_ENDPOINT_ID",
    "InsightModelResolver",
    "InsightModelSelection",
    "InsightProviderError",
    "InsightProviderErrorCode",
    "classify_provider_error",
    "create_insight_agent",
    "resolve_insight_model",
    "serialize_contract",
    "sha256_hex",
    "to_canonical_json",
]

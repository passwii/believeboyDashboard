"""Agent API audit logging middleware（external_audit.py 改名，设计稿 §11）。

Records one ``agent_api_audit_log`` row per ``/api/v1/agent/*`` request:
method, path, resolved API key id, status code, latency and client IP. The
key id is read from ``request.state`` (stamped by
``require_external_api_key``); anonymous / master-key / skip traffic logs
with ``api_key_id=NULL``. ``/api/v1/external/*`` was retired in V3
(BLF-459) and is intentionally not audited.

BLF-460 读操作明细：每条记录额外解析并落 ``project_id``（path 正则
``/projects/(\d+)``）与 ``operation_type``（业务域，path 片段映射表）。

Design guarantees:
* Never breaks a request — every DB touch is wrapped and swallowed.
* Gated by ``agent_api_audit_enabled`` (default on).
* Bounded by the 90-day Celery retention sweep.
"""

from __future__ import annotations

import logging
import re
import time

from fastapi import FastAPI, Request
from starlette.responses import Response

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.agent_api_audit_log import AgentApiAuditLog

logger = logging.getLogger(__name__)

# 仅审计 /api/v1/agent/*；/api/v1/external/* 已于 V3（BLF-459）下线并停止审计。
AUDITED_PREFIXES = ("/api/v1/agent/",)

# 业务域 path 片段映射（长片段优先）。与 frontend/lib/agent-domains.ts 注册表
# 及 agent/__init__.py 路由接线保持一致；覆盖 external 镜像读路由片段，
# 否则规划中域的读访问会全落「其他」。新增业务域时同步维护本表。
AGENT_PATH_DOMAIN_MAP: tuple[tuple[str, str], ...] = (
    ("/new-product-calculations", "new_product_calculations"),
    ("/pricing-snapshots", "new_product_calculations"),
    ("/shop-calculation", "shop_calculations"),
    ("/return-analysis", "return_analysis"),
    ("/replenishment-analysis", "inventory_ledger"),
    ("/inventory-ledger", "inventory_ledger"),
    ("/sku-info", "inventory_ledger"),
    # BLF-569：销售数据域（路径 orders/summary → sales/summary，域 code
    # orders → sales）。v3 下线（BLF-571，2026-08-10）后旧路径 /orders/ 已移除。
    ("/sales/", "sales"),
    ("/ad-", "ad_analysis"),
    ("/shipments", "shipments"),
)

_PROJECT_ID_RE = re.compile(r"/projects/(\d+)")


def parse_audit_path_meta(path: str) -> tuple[int | None, str | None]:
    """从请求 path 解析 (project_id, operation_type)。

    纯函数，便于单测；project_id 取 ``/projects/\d+`` 首个命中，operation_type
    走 ``AGENT_PATH_DOMAIN_MAP`` 长片段优先匹配，未命中返回 ``None``（前端
    显示「其他/未知」）。
    """
    match = _PROJECT_ID_RE.search(path)
    project_id = int(match.group(1)) if match else None
    operation_type = None
    for fragment, domain in AGENT_PATH_DOMAIN_MAP:
        if fragment in path:
            operation_type = domain
            break
    return project_id, operation_type


def _client_ip(request: Request) -> str | None:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    if request.client:
        return request.client.host[:64]
    return None


def _write_audit(
    *,
    method: str,
    path: str,
    api_key_id: int | None,
    status_code: int,
    latency_ms: int,
    ip_address: str | None,
) -> None:
    project_id, operation_type = parse_audit_path_meta(path)
    db = SessionLocal()
    try:
        db.add(
            AgentApiAuditLog(
                method=method[:16],
                path=path[:255],
                api_key_id=api_key_id,
                project_id=project_id,
                operation_type=operation_type,
                status_code=status_code,
                latency_ms=latency_ms,
                ip_address=ip_address,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001 — audit must never fail the request
        logger.exception("agent API audit write failed")
        db.rollback()
    finally:
        db.close()


def register_agent_api_audit_middleware(app: FastAPI) -> None:
    """Attach the audit middleware to ``app`` (called from ``main.py``)."""

    @app.middleware("http")
    async def agent_api_audit_middleware(request: Request, call_next):
        path = request.url.path
        if (
            request.method == "OPTIONS"
            or not path.startswith(AUDITED_PREFIXES)
            or not get_settings().agent_api_audit_enabled
        ):
            return await call_next(request)

        start = time.perf_counter()
        response: Response | None = None
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        except Exception:
            status_code = 500
            raise
        finally:
            latency_ms = int((time.perf_counter() - start) * 1000)
            api_key_id = getattr(request.state, "external_api_key_id", None)
            if api_key_id is None:
                api_key_id = getattr(request.state, "agent_api_key_id", None)
            _write_audit(
                method=request.method,
                path=path,
                api_key_id=api_key_id,
                status_code=status_code,
                latency_ms=latency_ms,
                ip_address=_client_ip(request),
            )

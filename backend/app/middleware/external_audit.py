"""External API audit logging middleware (BEL-377).

Records one ``external_api_audit_log`` row per ``/api/v1/external/*``
request: method, path, resolved API key id, status code, latency and client
IP. The key id is read from ``request.state`` (stamped by
``require_external_api_key``); anonymous / master-key / skip traffic logs
with ``api_key_id=NULL``.

Design guarantees:
* Never breaks a request — every DB touch is wrapped and swallowed.
* Gated by ``external_api_audit_enabled`` (default on).
* Bounded by the 90-day Celery retention sweep.
"""

from __future__ import annotations

import logging
import time

from fastapi import FastAPI, Request
from starlette.responses import Response

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models.external_api_audit_log import ExternalApiAuditLog

logger = logging.getLogger(__name__)

EXTERNAL_PREFIX = "/api/v1/external/"


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
    db = SessionLocal()
    try:
        db.add(
            ExternalApiAuditLog(
                method=method[:16],
                path=path[:255],
                api_key_id=api_key_id,
                status_code=status_code,
                latency_ms=latency_ms,
                ip_address=ip_address,
            )
        )
        db.commit()
    except Exception:  # noqa: BLE001 — audit must never fail the request
        logger.exception("external API audit write failed")
        db.rollback()
    finally:
        db.close()


def register_external_audit_middleware(app: FastAPI) -> None:
    """Attach the audit middleware to ``app`` (called from ``main.py``)."""

    @app.middleware("http")
    async def external_audit_middleware(request: Request, call_next):
        path = request.url.path
        if (
            request.method == "OPTIONS"
            or not path.startswith(EXTERNAL_PREFIX)
            or not get_settings().external_api_audit_enabled
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
            _write_audit(
                method=request.method,
                path=path,
                api_key_id=api_key_id,
                status_code=status_code,
                latency_ms=latency_ms,
                ip_address=_client_ip(request),
            )

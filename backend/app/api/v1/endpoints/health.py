import time
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.config import get_settings
from app.core.security import require_api_key
from app.db.session import SessionLocal
from app.services.infra.redis import make_redis_probe_client

router = APIRouter()
settings = get_settings()


class HealthResponse(BaseModel):
    status: str
    timestamp: float
    database: str
    redis: str
    version: str | None = None


@router.get("/health", response_model=HealthResponse)
async def health(_=Depends(require_api_key)) -> HealthResponse:
    """Enhanced health check with DB + Redis status for monitoring."""
    ts = time.time()

    db_status = "unknown"
    try:
        db = SessionLocal()
        try:
            result = db.execute(text("SELECT 1 AS ping"))
            row = result.fetchone()
            db_status = "ok" if row and row[0] == 1 else "error"
        finally:
            db.close()
    except Exception as e:
        db_status = f"error: {e}"

    # 共享 infra 内的 Redis 客户端工厂,使用短 timeout 避免 health probe 被长
    # socket_timeout 拖死;不复用主单例连接池,避免探测流量占用业务连接。
    redis_status = "unavailable"
    if not settings.redis_host:
        redis_status = "not configured"
    else:
        probe = None
        try:
            probe = make_redis_probe_client(
                socket_timeout=2,
                socket_connect_timeout=2,
                health_check_interval=0,
            )
            start = time.perf_counter()
            probe.ping()
            latency_ms = (time.perf_counter() - start) * 1000
            redis_status = f"ok ({latency_ms:.1f}ms)"
        except Exception as e:
            # 避免外泄 socket 错误细节,只暴露类型
            redis_status = f"error: {type(e).__name__}"
        finally:
            if probe is not None:
                try:
                    probe.connection_pool.disconnect()
                except Exception:
                    pass

    return HealthResponse(
        status="ok" if db_status == "ok" else "degraded",
        timestamp=ts,
        database=db_status,
        redis=redis_status,
        version=get_settings().app_env,
    )


@router.get("/health/live")
async def health_live():
    """Lightweight liveness probe — no DB, no auth. For k8s/orchestrator."""
    return {"status": "ok", "timestamp": time.time()}


@router.get("/health/ready")
async def health_ready() -> dict:
    """
    Readiness probe — DB connectivity required.
    Returns 503 if DB is unreachable, signaling orchestrator to stop routing traffic.
    """
    try:
        db = SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
        return {"status": "ok", "timestamp": time.time()}
    except Exception:
        return {"status": "unavailable", "timestamp": time.time()}, status.HTTP_503_SERVICE_UNAVAILABLE
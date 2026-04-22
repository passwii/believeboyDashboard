import time
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.config import get_settings
from app.core.security import require_api_key
from app.db.session import SessionLocal

router = APIRouter()
settings = get_settings()

# Optional Redis dependency (graceful degradation if unavailable)
_redis_client = None


def get_redis_client():
    global _redis_client
    if _redis_client is None:
        try:
            import redis

            _redis_client = redis.Redis(
                host=settings.redis_host,
                port=settings.redis_port,
                password=settings.redis_password or None,
                db=settings.redis_db,
                socket_connect_timeout=2,
                socket_timeout=2,
                decode_responses=True,
            )
            _redis_client.ping()
        except Exception:
            _redis_client = None
    return _redis_client


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

    redis_status = "unavailable"
    try:
        r = get_redis_client()
        if r is not None:
            start = time.perf_counter()
            r.ping()
            latency_ms = (time.perf_counter() - start) * 1000
            redis_status = f"ok ({latency_ms:.1f}ms)"
        else:
            redis_status = "not configured"
    except Exception as e:
        redis_status = f"error: {e}"

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
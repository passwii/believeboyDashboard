import time
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import text

from app.core.config import get_settings
from app.core.security import require_api_key
from app.db import session as db_session
from app.db.replica import get_breaker_snapshot, is_breaker_open
from app.services.infra.redis import make_redis_probe_client

router = APIRouter()
settings = get_settings()

# Lag threshold (seconds) at which the replica is reported as degraded.
# Mirrors the threshold in the issue body ("replica lag... > 10s 报警").
REPLICA_LAG_DEGRADED_SECONDS = 10.0


class HealthResponse(BaseModel):
    status: str
    timestamp: float
    database: str
    database_replica: str
    redis: str
    redis_memory: str | None = None
    version: str | None = None


def _probe_primary() -> str:
    """Ping the primary engine and return a status string."""
    try:
        db = db_session.SessionLocal()
        try:
            result = db.execute(text("SELECT 1 AS ping"))
            row = result.fetchone()
            return "ok" if row and row[0] == 1 else "error"
        finally:
            db.close()
    except Exception as e:
        return f"error: {e}"


def _probe_replica() -> str:
    """Ping the replica engine and return a status string with lag.

    Reads `pg_last_xact_replay_timestamp()` — this function exists on
    a hot-standby and returns NULL on the primary. We probe via the
    read engine itself (not via a primary connection) so the result
    reflects the actual replica server the app would be talking to.
    """
    if db_session.ReadSessionLocal is None:
        return "not configured"

    breaker = get_breaker_snapshot()
    if is_breaker_open():
        return (
            f"breaker open (failures={breaker['consecutive_failures']}, "
            f"reads → primary)"
        )

    try:
        db = db_session.ReadSessionLocal()
        try:
            row = db.execute(
                text(
                    "SELECT EXTRACT(EPOCH FROM "
                    "(now() - pg_last_xact_replay_timestamp()))::float "
                    "AS lag_seconds"
                )
            ).first()
            if row is None or row[0] is None:
                # pg_last_xact_replay_timestamp returns NULL when no
                # transactions have been replayed yet, OR when running
                # against a primary. Distinguish: if read engine is
                # configured, treat NULL as "ok, fresh replica".
                return "ok"
            lag = float(row[0])
            if lag < REPLICA_LAG_DEGRADED_SECONDS:
                return f"ok (lag={lag:.1f}s)"
            return f"degraded (lag={lag:.1f}s > {REPLICA_LAG_DEGRADED_SECONDS:.0f}s)"
        finally:
            db.close()
    except Exception as e:
        return f"error: {type(e).__name__}"


@router.get("/health", response_model=HealthResponse)
async def health(_=Depends(require_api_key)) -> HealthResponse:
    """Enhanced health check with DB + replica + Redis status for monitoring."""
    ts = time.time()

    db_status = _probe_primary()
    replica_status = _probe_replica()

    # 共享 infra 内的 Redis 客户端工厂,使用短 timeout 避免 health probe 被长
    # socket_timeout 拖死;不复用主单例连接池,避免探测流量占用业务连接。
    redis_status = "unavailable"
    redis_memory = None
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
            # 内存监控：INFO memory 取 used_memory_human
            try:
                info = probe.info("memory")
                redis_memory = info.get("used_memory_human", "unknown")
            except Exception:
                redis_memory = "unavailable"
        except Exception as e:
            # 避免外泄 socket 错误细节,只暴露类型
            redis_status = f"error: {type(e).__name__}"
        finally:
            if probe is not None:
                try:
                    probe.connection_pool.disconnect()
                except Exception:
                    pass

    # Overall status: degraded if primary is broken, OR replica is
    # configured but degraded/error (we expect replica to be up).
    overall = "ok"
    if db_status != "ok":
        overall = "degraded"
    elif replica_status.startswith("degraded") or replica_status.startswith("error"):
        overall = "degraded"

    return HealthResponse(
        status=overall,
        timestamp=ts,
        database=db_status,
        database_replica=replica_status,
        redis=redis_status,
        redis_memory=redis_memory,
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
        db = db_session.SessionLocal()
        try:
            db.execute(text("SELECT 1"))
        finally:
            db.close()
        return {"status": "ok", "timestamp": time.time()}
    except Exception:
        return {
            "status": "unavailable",
            "timestamp": time.time(),
        }, status.HTTP_503_SERVICE_UNAVAILABLE

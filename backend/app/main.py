import logging
import time
from urllib.parse import unquote
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.db.session import ReadSessionLocal, SessionLocal
from app.services.audit_log_service import sync_operation_audit_log_sequence
from app.core.scheduler import init_scheduler, shutdown_scheduler
# BEL-128: 显式 import celery_app，让 Celery 构造时 `set_as_current=True` 把 `current_app`
# 绑定到我们的 `Celery("believeboy", ...)` 实例。否则 `@shared_task` 装饰的 task
# 在懒加载 import 时会 fallback 到 celery 默认 `Celery("default")`（broker=None → AMQP
# localhost:5672），导致手动 resend / ai_summary 等 Celery 任务在 API 进程里
# `.delay()` 时直接 `Connection refused`。详见 docs/superpowers/plans/2026-07-13-...
from app.tasks.celery_app import celery_app  # noqa: F401  -- side-effect import

limiter = Limiter(key_func=get_remote_address, default_limits=[])

settings = get_settings()

logging.basicConfig(level=logging.INFO, format='%(message)s')
request_logger = logging.getLogger('app.request')
performance_logger = logging.getLogger('app.performance')
startup_logger = logging.getLogger('app.startup')
logging.getLogger('uvicorn.access').disabled = True

# BEL-122: suppress APScheduler framework INFO noise from scheduled jobs.
logging.getLogger('apscheduler.schedulers.background').setLevel(logging.WARNING)
logging.getLogger('apscheduler.executors.default').setLevel(logging.WARNING)
logging.getLogger('apscheduler.jobstores.default').setLevel(logging.WARNING)

app = FastAPI(title=settings.app_name)
app.state.limiter = limiter


def _rate_limit_exceeded_handler(_request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Translate slowapi RateLimitExceeded into a 429 JSON response."""
    return JSONResponse(
        status_code=429,
        content={"detail": f"请求过于频繁，请稍后再试（{exc.detail}）"},
    )


app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

if not settings.frontend_url:
    raise Exception(
        "frontend_url must be set in backend .env. "
        "Add FRONTEND_URL=http://localhost:3200 (dev) or your production URL to backend/.env"
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "X-API-Key",
        "X-User-Id",
        "X-User-Name",
        "X-User-Email",
        "X-Operator",
        "X-Is-Admin",
        "X-Request-Id",
        "X-Forwarded-For",
        "User-Agent",
        "Accept",
        "Accept-Language",
    ],
)


@app.on_event('startup')
def on_startup() -> None:
    db = SessionLocal()
    try:
        sync_operation_audit_log_sequence(db)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    # BEL-55-P5 / BEL-73: probe the replica at startup so a misconfigured
    # `database_read_url` surfaces in the boot log instead of as silent
    # request failures. We do NOT crash the process — the breaker handles
    # a flaky replica at runtime; a hard failure here would block the
    # whole API. Just log and let the breaker / /health endpoint expose it.
    if ReadSessionLocal is not None:
        try:
            probe = ReadSessionLocal()
            try:
                probe.execute(text("SELECT 1 AS replica_ping"))
            finally:
                probe.close()
            startup_logger.info("BEL-73: read replica reachable at startup")
        except Exception as exc:  # noqa: BLE001
            startup_logger.warning(
                "BEL-73: read replica ping failed at startup, "
                "app will fall back to primary: %s",
                exc,
            )
    init_scheduler()


@app.on_event('shutdown')
def on_shutdown() -> None:
    shutdown_scheduler()


@app.middleware('http')
async def request_logging_middleware(request: Request, call_next):
    request_id = (request.headers.get('X-Request-Id') or '').strip() or uuid4().hex
    request.state.request_id = request_id

    start = time.perf_counter()
    response = None
    error_message = None
    try:
        response = await call_next(request)
        return response
    except Exception as exc:
        error_message = str(exc)
        raise
    finally:
        duration_ms = int((time.perf_counter() - start) * 1000)
        status_code = response.status_code if response is not None else 500

        if request.method != 'OPTIONS':
            # Skip logging for high-frequency, low-value endpoints
            if request.url.path.endswith('/presence/heartbeat'):
                pass  # Noisy, low-value - skip logging
            else:
                operator = unquote(request.headers.get('X-Operator', '')).strip()
                log_parts = [
                    f'[{status_code}]',
                    request.method,
                    request.url.path,
                    f'{duration_ms}ms',
                ]
                if operator:
                    log_parts.append(f'operator={operator}')
                if error_message:
                    log_parts.append(f'error={error_message}')
                else:
                    log_parts.append(f'request_id={request_id[:8]}')
                request_logger.info(' '.join(log_parts))

        if response is not None:
            response.headers['X-Request-Id'] = request_id
            response.headers['X-Response-Time-Ms'] = str(duration_ms)
            response.headers['Server-Timing'] = f'app;dur={duration_ms}'
            if duration_ms >= 800:
                performance_logger.info(
                    'slow_request path=%s method=%s status=%s duration_ms=%s request_id=%s',
                    request.url.path,
                    request.method,
                    status_code,
                    duration_ms,
                    request_id[:8],
                )

app.include_router(api_router, prefix='/api/v1')

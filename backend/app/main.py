import logging
import time
from urllib.parse import unquote
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.db.session import SessionLocal
from app.services.audit_log_service import sync_operation_audit_log_sequence

limiter = Limiter(key_func=get_remote_address, default_limits=[])

settings = get_settings()

logging.basicConfig(level=logging.INFO, format='%(message)s')
request_logger = logging.getLogger('app.request')
performance_logger = logging.getLogger('app.performance')
logging.getLogger('uvicorn.access').disabled = True

app = FastAPI(title=settings.app_name)
app.state.limiter = limiter

if not settings.frontend_url:
    raise Exception(
        "frontend_url must be set in backend .env. "
        "Add FRONTEND_URL=http://localhost:3000 (dev) or your production URL to backend/.env"
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
def sync_sequences_on_startup() -> None:
    db = SessionLocal()
    try:
        sync_operation_audit_log_sequence(db)
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


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

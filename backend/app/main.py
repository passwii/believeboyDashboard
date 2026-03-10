import logging
import time
from urllib.parse import unquote
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import get_settings

settings = get_settings()

logging.basicConfig(level=logging.INFO, format='%(message)s')
request_logger = logging.getLogger('app.request')
logging.getLogger('uvicorn.access').disabled = True

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)


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

app.include_router(api_router, prefix='/api/v1')

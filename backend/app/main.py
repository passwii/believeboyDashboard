import json
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
        operator = unquote(request.headers.get('X-Operator', '')).strip() or None
        forwarded_for = request.headers.get('x-forwarded-for')
        ip_address = forwarded_for.split(',')[0].strip() if forwarded_for else (request.client.host if request.client else None)

        request_logger.info(
            json.dumps(
                {
                    'event': 'http_request',
                    'service': settings.app_name,
                    'env': settings.app_env,
                    'request_id': request_id,
                    'method': request.method,
                    'path': request.url.path,
                    'status_code': response.status_code if response is not None else 500,
                    'duration_ms': duration_ms,
                    'operator': operator,
                    'ip': ip_address,
                    'user_agent': request.headers.get('user-agent'),
                    'error': error_message,
                },
                ensure_ascii=False,
            )
        )

        if response is not None:
            response.headers['X-Request-Id'] = request_id

app.include_router(api_router, prefix='/api/v1')

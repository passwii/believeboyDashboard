FROM public.ecr.aws/docker/library/python:3.13-slim-bookworm

ARG PIP_INDEX_URL=https://pypi.org/simple

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/backend \
    PATH=/opt/venv/bin:$PATH \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN python -m venv /opt/venv

COPY backend/requirements.txt /app/backend/requirements.txt
RUN --mount=type=cache,id=believeboy-pip-cache,target=/root/.cache/pip \
    pip install --index-url "${PIP_INDEX_URL}" -r /app/backend/requirements.txt

# Scheduled reports use the headless shell only; installing the full Chromium
# build would add hundreds of unused megabytes to every pull.
RUN --mount=type=cache,id=believeboy-playwright-cache,target=/root/.cache/ms-playwright \
    playwright install --with-deps --only-shell chromium

COPY backend /app/backend
COPY frontend/public/logo-email.png /app/frontend/public/logo-email.png

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app/backend/storage /var/lib/believeboy \
    && chown -R app:app /app /var/lib/believeboy

USER app
WORKDIR /app/backend

EXPOSE 8100

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/api/v1/health/live', timeout=3)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100", "--no-access-log", "--workers", "1"]

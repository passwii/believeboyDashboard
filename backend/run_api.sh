#!/usr/bin/env bash
set -euo pipefail

uvicorn app.main:app --host "${APP_HOST:-0.0.0.0}" --port "${APP_PORT:-8000}" --no-access-log --reload --reload-delay 30

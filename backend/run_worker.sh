#!/usr/bin/env bash
#
# Local Celery worker launcher.
#
# Production uses `backend/deploy/systemd/believeboy-celery.service` which
# boots a single multi-process worker via the `celery worker` command. This
# script mirrors that behaviour for local dev while also exposing a thin
# wrapper around `celery multi` for spinning up multiple worker processes
# when capacity is needed (BEL-55-P4).
#
# Usage:
#   ./run_worker.sh                      # single worker, default queues
#   ./run_worker.sh multi <N>            # spin up N worker processes via
#                                        # `celery multi start`
#   ./run_worker.sh stop                 # `celery multi stop` (used with multi)
#   ./run_worker.sh ping                 # round-trip the smoke-test task

set -euo pipefail

# Resolve project root (this script lives in backend/, cd there so celery
# can import the app package no matter where the user invokes it from).
cd "$(dirname "$0")"

# Pull env vars from .env if present — the Celery app reads REDIS_*
# / CELERY_* via pydantic-settings, but `celery multi` itself doesn't
# care, so the .env load is just a developer convenience.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Concurrency per worker process. Production systemd units now hard-code
# their own value (--concurrency=2 in believeboy-celery.service), but this
# var still feeds the fallback `worker_concurrency` in `app.tasks.celery_app`
# and the local dev launcher `run_worker.sh`. Override per-machine to taste;
# 4 is fine for a beefy dev box, drop to 2 on a 2 GiB VPS-like host.
CONCURRENCY="${CELERY_WORKER_CONCURRENCY:-4}"
QUEUES="${CELERY_WORKER_QUEUES:-default,reports,insights}"
LOG_LEVEL="${CELERY_WORKER_LOG_LEVEL:-info}"
APP="app.tasks.celery_app"

CMD="${1:-single}"

case "$CMD" in
  single)
    # Single multi-process worker process. Matches the systemd unit's
    # shape (`-c` flag is the per-process concurrency, not the number of
    # worker processes). Use this for everyday dev.
    exec celery -A "$APP" worker -Q "$QUEUES" -c "$CONCURRENCY" -l "$LOG_LEVEL"
    ;;

  multi)
    # Multiple worker PROCESSES (each with its own concurrency). Use
    # when one process can't keep up — typically on a 4-core box where
    # you want 2 worker processes × 4 concurrency = 8 task slots.
    N="${2:-2}"
    if ! [[ "$N" =~ ^[1-9][0-9]*$ ]]; then
      echo "multi: argument must be a positive integer (got '$N')" >&2
      exit 64
    fi
    # `celery multi start` daemonises each child and writes pidfiles
    # into ./run/celery/. Stdout for each child goes to ./log/celery/
    # via `-l` and a per-process logfile. We keep the log format
    # identical to systemd's journal stream so log-grep recipes in
    # backend/docs/multi-worker-ops.md work in both cases.
    mkdir -p run/celery log/celery
    exec celery -A "$APP" multi start "$N" \
      -Q "$QUEUES" \
      -c "$CONCURRENCY" \
      -l "$LOG_LEVEL" \
      --pidfile=run/celery/celery_%n.pid \
      --logfile=log/celery/celery_%n%I.log
    ;;

  stop)
    # Stop every child started by `multi start`. `celery multi stop`
    # reads the pidfiles from the same --pidfile template.
    if [ ! -d run/celery ]; then
      echo "stop: no run/celery/ directory; was this started via 'multi'?" >&2
      exit 1
    fi
    exec celery -A "$APP" multi stop \
      --pidfile=run/celery/celery_%n.pid
    ;;

  ping)
    # Quick round-trip check. The worker must be running separately
    # (e.g. via the systemd unit or `./run_worker.sh single` in another
    # terminal). Exits non-zero on timeout.
    exec python -c "from app.tasks.celery_app import ping; print(ping.apply().get(timeout=10))"
    ;;

  *)
    echo "Usage: $0 [single | multi <N> | stop | ping]" >&2
    exit 64
    ;;
esac

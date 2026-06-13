"""Integration test for `app.celery_tasks.ping`.

Spins up a Celery worker in a subprocess (own process group), fires
`ping.delay()`, and asserts the round-trip returns "pong". Requires a local
Redis on `REDIS_HOST:REDIS_PORT` (defaulting to localhost:6379) and skips the
round-trip if Redis is unreachable.

This is the BEL-55-P0 acceptance check "ping round-trip in local passes" in
automated form.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _redis_alive(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


@pytest.fixture(scope="module")
def worker_env() -> dict[str, str]:
    """Env vars needed for the worker subprocess to boot and connect to Redis.

    Starts from a clean slate — overrides REDIS_* explicitly so a prior test
    in the same `pytest` run that monkeypatched REDIS_HOST (e.g. the config
    tests) does not leak into the worker subprocess.
    """
    env = os.environ.copy()
    # DATABASE_URL is required by Settings() — set a dummy one for the worker
    # subprocess. The worker only needs Redis (not the DB) for the ping task,
    # but Settings() validates at import time.
    env["DATABASE_URL"] = "postgresql+psycopg://x:x@localhost:5432/x"
    env["REDIS_HOST"] = "localhost"
    env["REDIS_PORT"] = "6379"
    env["REDIS_DB"] = "0"
    env["CELERY_BROKER_URL"] = "redis://localhost:6379/1"
    env["CELERY_RESULT_URL"] = "redis://localhost:6379/2"
    return env


def test_ping_round_trip(worker_env: dict[str, str]) -> None:
    """Boot a Celery worker, run ping, assert it returns 'pong'."""
    redis_host = worker_env.get("REDIS_HOST", "localhost")
    redis_port = int(worker_env.get("REDIS_PORT", "6379"))
    if not _redis_alive(redis_host, redis_port):
        pytest.skip(f"Redis at {redis_host}:{redis_port} is not reachable")

    # Rebuild the parent-process Celery app so its broker/backend URLs
    # reflect the *current* REDIS_* env, not whatever an earlier test in the
    # same pytest run monkeypatched in. The worker subprocess is fine on its
    # own, but the parent has to publish to the right broker.
    from app.core import config as config_mod
    from app.tasks import celery_app as celery_app_mod

    config_mod.get_settings.cache_clear()
    celery_app_mod.celery_app = celery_app_mod._build_celery_app()
    config_mod.get_settings.cache_clear()

    # Start the worker in its own process group so we can kill the whole
    # group (master + prefork children) on teardown. Use `-l info` so we get
    # the `celery@<host> ready.` banner — at `-l warning` it's suppressed.
    worker_proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "celery",
            "-A",
            "app.tasks.celery_app",
            "worker",
            "-l",
            "info",
            "-Q",
            "default",
            "--concurrency=1",
        ],
        cwd=str(PROJECT_ROOT),
        env=worker_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,  # detached process group on POSIX
    )

    try:
        # Wait for the worker to bind and start consuming.
        # `celery@<host> ready.` is logged once all queues are subscribed and
        # the worker accepts messages. We give it up to 15s.
        ready_seen = False
        deadline = time.monotonic() + 15.0
        assert worker_proc.stdout is not None
        while time.monotonic() < deadline:
            line = worker_proc.stdout.readline()
            if not line:
                break
            if "ready" in line.lower() and "celery@" in line.lower():
                ready_seen = True
                break
        if not ready_seen:
            pytest.fail("Celery worker did not become ready within 15s")

        # Fire the task and wait for the result.
        from app.tasks.celery_app import ping

        result = ping.delay().get(timeout=10)
        assert result == "pong"
    finally:
        # Kill the whole process group (master + prefork child) so the test
        # doesn't hang waiting on the child.
        try:
            os.killpg(worker_proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            worker_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(worker_proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            worker_proc.wait(timeout=5)

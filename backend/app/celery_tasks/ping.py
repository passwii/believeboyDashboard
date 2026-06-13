"""Smoke-test task used to verify the Celery wiring is healthy end-to-end.

The worker systemd unit boots a process that imports this module via
`app.tasks.celery_app`'s `include=[...]` list. Running `ping.delay()` from
the API process (or any shell with the project's `.env` loaded) should
round-trip and return ``"pong"`` within a few seconds.
"""

from __future__ import annotations

from celery import shared_task


@shared_task(name="app.celery_tasks.ping.ping")
def ping() -> str:
    """Trivial task that returns ``"pong"`` — used to verify worker plumbing."""
    return "pong"

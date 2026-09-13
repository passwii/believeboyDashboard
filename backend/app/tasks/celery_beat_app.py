"""Beat-only Celery application (BLF-1047).

`celery beat` publishes *task names* to the broker; it never executes or needs
the task implementations. But beat calls the same loader hook as a worker at
startup (`celery/apps/beat.py:Beat.init_loader` → `app.loader.init_worker()` →
`import_default_modules()`), which eagerly imports everything in the app's
`include=[...]`.

Pointing the beat systemd unit at `app.tasks.celery_app` therefore dragged the
whole chain `app.celery_tasks.*` → `app.services.*` → `app.models.*` /
`app.db.*` into the scheduler process. Measured on the production VPS
(2026-09-14, PYTHONPATH=. .venv/bin/python, dump of `sys.modules` from a real
`celery beat` process):

* `celery_app` app: 202MB RSS / 177MB RssAnon, 153 `app.*` modules loaded
  (every task module + every SQLAlchemy model), `0` of which beat uses;
* same beat with `include=[]`: ~70MB RSS.

So beat gets its own app below: same broker, timezone, default queue, task
routes and beat schedule as the worker app — but an empty `include`, so nothing
from the task/service/model layer is imported. The tables themselves live in
`app/tasks/celery_shared.py`, imported by both apps, so the publisher (beat) and
the executor (worker) can never disagree about a schedule or a queue.

The settings/routing half of this module is intentionally a mirror of the
worker app's *publish-relevant* config only. Worker-only knobs (`task_acks_late`,
`worker_prefetch_multiplier`, `worker_concurrency`, log format) stay out —
`tests/tasks/test_celery_beat_app.py` pins the shared half so the two apps
cannot silently drift apart.
"""

from __future__ import annotations

from celery import Celery

from app.core.config import get_settings
from app.tasks.celery_shared import (
    BEAT_SCHEDULE,
    CELERY_DEFAULT_QUEUE,
    CELERY_TASK_TIMEZONE,
    TASK_ROUTES,
)


def _build_beat_app() -> Celery:
    """Construct the Celery app used only by `celery -A ... beat`.

    `include=[]` is the point of this app: it is what keeps the task-module
    import chain out of the scheduler process. Do not add task modules here —
    the beat process sends messages by task name and never resolves the
    implementations (`celery/beat.py:Scheduler.apply_async` falls back to
    `app.send_task(name)` when the name is not registered).
    """
    settings = get_settings()

    app = Celery(
        "believeboy-beat",
        broker=settings._celery_broker_url_resolved,
        # Beat never stores a task result, but the URL is kept so the two apps
        # stay configurable from one env var and a future schema/inspection
        # command from the beat process can't blow up on a missing backend.
        backend=settings._celery_result_url_resolved,
        include=[],
    )

    app.conf.update(
        # Shared with the worker app (app/tasks/celery_shared.py). `task_routes`
        # and `task_default_queue` matter at *publish* time, so beat must carry
        # them: without the routes, `dispatch_one` would be published to
        # `default` instead of the `scheduled` queue (breaking the screenshot
        # memory isolation); without the default queue, anything unrouted would
        # land on Celery's built-in `celery` queue that no worker consumes and
        # the task would silently never run.
        beat_schedule=BEAT_SCHEDULE,
        task_default_queue=CELERY_DEFAULT_QUEUE,
        task_routes=TASK_ROUTES,
        # All timestamps in messages/results use project timezone.
        timezone=CELERY_TASK_TIMEZONE,
        enable_utc=True,
    )

    return app


celery_beat_app: Celery = _build_beat_app()

# `celery -A app.tasks.celery_beat_app` resolves the module attribute `app`
# first (celery/app/utils.py:find_app); exposing it explicitly pins the
# resolution instead of relying on celery's "first Celery instance in the
# module namespace" fallback.
app = celery_beat_app

__all__ = ["app", "celery_beat_app"]

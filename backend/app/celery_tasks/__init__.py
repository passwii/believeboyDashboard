"""Shared Celery tasks for the believeboy backend.

Tasks are registered via `@shared_task` so they bind to whatever Celery app
is loaded by the worker (`app.tasks.celery_app.celery_app`). The `include`
list in `celery_app.py` is the source of truth for which modules are eagerly
imported at worker boot.
"""

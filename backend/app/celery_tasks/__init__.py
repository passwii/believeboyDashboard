"""Shared Celery tasks for the believeboy backend.

Tasks are registered via `@shared_task` so they bind to whatever Celery app
is loaded by the worker (`app.tasks.celery_app.celery_app`). The `include`
list in `celery_app.py` is the source of truth for which modules are eagerly
imported at worker boot.

This package is intentionally empty in BEL-55-P0: only the smoke-test `ping`
task lives here. Business handlers (monthly_report, product_analysis, AI
insights, ...) move here in BEL-55-P1+.
"""

from app.tasks import celery_app as celery_app_mod


def test_backup_task_registered_and_routed_to_backups_queue():
    fresh = celery_app_mod._build_celery_app()
    assert "app.celery_tasks.backup" in fresh.conf.include
    routes = fresh.conf.task_routes or {}
    assert routes["app.celery_tasks.backup.run_backup_task"]["queue"] == "backups"

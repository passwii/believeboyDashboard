from app.tasks import celery_app as celery_app_mod


def test_backup_task_registered_and_routed_to_backups_queue():
    fresh = celery_app_mod._build_celery_app()
    assert "app.celery_tasks.backup" in fresh.conf.include
    routes = fresh.conf.task_routes or {}
    assert routes["app.celery_tasks.backup.run_backup_task"]["queue"] == "backups"


def test_beat_schedule_has_daily_backup_and_cleanup():
    fresh = celery_app_mod._build_celery_app()
    beat = fresh.conf.beat_schedule or {}
    assert "daily-pg-full-backup" in beat
    assert beat["daily-pg-full-backup"]["task"] == "app.celery_tasks.backup.schedule_daily_backup_task"
    assert beat["daily-pg-full-backup"]["kwargs"] == {"backup_type": "full", "triggered_by": "auto"}
    assert "r2-backup-cleanup" in beat
    assert beat["r2-backup-cleanup"]["task"] == "app.celery_tasks.backup.cleanup_r2_task"

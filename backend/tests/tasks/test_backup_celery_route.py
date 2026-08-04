from app.tasks import celery_app as celery_app_mod


def test_backup_task_registered_and_routed_to_default_queue():
    """简化决策（BEL-418）：备份不单独起 worker，run_backup_task 走 default 队列。

    task_routes 里不得出现 backups 队列路由（无 worker 消费会导致任务永久堆积）。
    """
    fresh = celery_app_mod._build_celery_app()
    assert "app.celery_tasks.backup" in fresh.conf.include
    routes = fresh.conf.task_routes or {}
    assert "app.celery_tasks.backup.run_backup_task" not in routes
    assert fresh.conf.task_default_queue == "default"


def test_beat_schedule_has_daily_backup_and_cleanup():
    fresh = celery_app_mod._build_celery_app()
    beat = fresh.conf.beat_schedule or {}
    assert "daily-pg-full-backup" in beat
    assert (
        beat["daily-pg-full-backup"]["task"]
        == "app.celery_tasks.backup.schedule_daily_backup_task"
    )
    assert beat["daily-pg-full-backup"]["kwargs"] == {
        "backup_type": "full",
        "triggered_by": "auto",
    }
    assert "r2-backup-cleanup" in beat
    assert (
        beat["r2-backup-cleanup"]["task"] == "app.celery_tasks.backup.cleanup_r2_task"
    )

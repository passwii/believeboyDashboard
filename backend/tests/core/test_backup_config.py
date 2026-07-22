from app.core.config import Settings


def test_backup_config_defaults():
    s = Settings(_env_file=None, database_url="postgresql+psycopg://u:p@localhost:5432/x")
    assert s.backup_soft_time_limit == 5400
    assert s.backup_hard_time_limit == 7200
    assert s.backup_r2_retention_count == 7
    assert s.backup_daily_schedule_hour == 3

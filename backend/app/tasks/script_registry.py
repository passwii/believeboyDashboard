from app.tasks.scripts.daily_report import run as run_daily_report

SCRIPT_HANDLERS = {
    'daily_report': run_daily_report,
}

from app.tasks.scripts.monthly_report import run as run_monthly_report
from app.tasks.scripts.product_analysis import run as run_product_analysis

SCRIPT_HANDLERS = {
    'monthly_report': run_monthly_report,
    'product_analysis': run_product_analysis,
}
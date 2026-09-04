_HANDLERS: dict | None = None


def get_script_handlers():
    global _HANDLERS
    if _HANDLERS is None:
        from app.tasks.scripts.monthly_report import run as run_monthly_report
        from app.tasks.scripts.product_analysis import run as run_product_analysis
        _HANDLERS = {
            'monthly_report': run_monthly_report,
            'product_analysis': run_product_analysis,
        }
    return _HANDLERS


def __getattr__(name):
    if name == "SCRIPT_HANDLERS":
        return get_script_handlers()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
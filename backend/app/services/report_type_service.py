AD_PRODUCT_REPORT = 'ad_product_report'
LEGACY_AD_REPORT = 'ad_report'

REPORT_TYPE_ALIASES: dict[str, str] = {
    LEGACY_AD_REPORT: AD_PRODUCT_REPORT,
}


def normalize_report_type(report_type: str) -> str:
    normalized = str(report_type or '').strip()
    return REPORT_TYPE_ALIASES.get(normalized, normalized)


def legacy_report_types_for(report_type: str) -> tuple[str, ...]:
    normalized = normalize_report_type(report_type)
    if normalized == AD_PRODUCT_REPORT:
        return (LEGACY_AD_REPORT,)
    return ()

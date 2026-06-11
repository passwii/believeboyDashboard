"""Regression test: rebuild_pt3_pt4_for_report must pass country to compute_metrics.

Bug history (2026-06-11): After recalculate API returned 200, VAT was still 0
in DB because rebuild_pt3_pt4_for_report called compute_metrics(classified) without
country, so US/DE/UK all returned income_vat_total=0.

After fix: compute_metrics(classified, country=report.country) → DE/UK get VAT
"""
from decimal import Decimal
from unittest.mock import MagicMock, patch

from app.models.monthly_report import MonthlyReport


def test_rebuild_passes_country_to_compute_metrics():
    """rebuild_pt3_pt4_for_report must call compute_metrics with country=report.country."""
    from app.services.report.monthly import rebuild_pt3_pt4_for_report

    db = MagicMock()
    report = MagicMock(spec=MonthlyReport)
    report.id = 198
    report.country = "DE"
    report.project_name = "弥森"
    report.report_month = "2026-03"

    db.get.return_value = report

    fake_rows = [
        {
            "type": "Order",
            "fulfillment": "Amazon",
            "product sales": "100",
            "product sales tax": "19",
            "selling fees": "-15",
            "fba fees": "-5",
            "shipping credits": "0",
            "promotional rebates": "0",
            "gift wrap credits": "0",
            "other": "0",
            "total": "99",
            "description": "",
        },
    ]

    fake_pt3 = {
        "income_total": Decimal("119"),
        "income_vat_total": Decimal("19"),
        "income_sales_with_tax": Decimal("119"),
        "expense_total": Decimal("-20"),
        "advertising_percentage": Decimal("0"),
    }
    fake_pt4 = {
        "income_total": Decimal("119"),
        "expense_total": Decimal("-20"),
        "expense_vat_total": Decimal("19"),
        "amazon_pay_back": Decimal("80"),
    }

    with patch("app.services.report.monthly._load_transaction_raw_rows", return_value=fake_rows), \
         patch("app.services.report.monthly.classify_rows", return_value={"order": fake_rows}), \
         patch("app.services.report.monthly.compute_metrics", return_value={"pt3": fake_pt3, "pt4": fake_pt4}) as mock_compute:
        result = rebuild_pt3_pt4_for_report(db, 198)

    # 关键断言：compute_metrics 必须用 country=report.country 调用
    mock_compute.assert_called_once()
    args, kwargs = mock_compute.call_args
    assert kwargs.get("country") == "DE", (
        f"compute_metrics 必须用 country='DE' 调用（来自 report.country），"
        f"实际参数: args={args}, kwargs={kwargs}"
    )
    assert result is True

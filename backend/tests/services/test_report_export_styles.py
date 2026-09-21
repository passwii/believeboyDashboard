"""Regression tests for monthly report workbook styling."""

from openpyxl import Workbook

from app.services.report.export import _apply_monthly_like_styles


def test_apply_monthly_like_styles_sets_widths_for_non_core_sheets():
    """Styling the detail sheets must not fail during Excel export."""
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "交易一览"
    worksheet.append(["年月", "金额"])
    worksheet.append(["2026-09", 12.34])

    _apply_monthly_like_styles(workbook)

    assert worksheet.column_dimensions["A"].width == 14
    assert worksheet.column_dimensions["B"].width == 14

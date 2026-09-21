"""Regression tests for monthly report workbook styling."""

from io import BytesIO

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Protection

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


def test_apply_monthly_like_styles_uses_complete_parity_styles():
    """Header and alternating body rows use complete named styles."""
    workbook = Workbook()
    summary = workbook.active
    summary.title = "报表核算"
    summary.append(["收入", "金额"])
    summary.append(["销售额", 12.34])
    summary.append(["退款", -1.23])

    detail = workbook.create_sheet(title="交易一览")
    detail.append(["年月", "金额"])
    detail.append(["2026-09", 12.34])
    detail.append(["2026-08", 10.00])

    _apply_monthly_like_styles(workbook)

    assert summary["A1"].style == "sty1"
    assert summary["A2"].style == "sty2_even"
    assert summary["A3"].style == "sty2_odd"
    assert detail["A1"].style == "sty1"
    assert detail["A2"].style == "sty2_even"
    assert detail["A3"].style == "sty2_odd"
    assert summary["A2"].fill.fgColor.rgb == "FFFFFFFF"
    assert summary["A3"].fill.fgColor.rgb == "FFF8FAFC"


def test_apply_monthly_like_styles_preserves_number_formats_after_reload():
    """Fast visual styling must not reset formats assigned by export writers."""
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "交易一览"
    worksheet.append(["指标", "比例"])
    worksheet.append(["退款率", 0.125])
    worksheet["B2"].number_format = "0.00%"
    worksheet["B2"].protection = Protection(locked=False)

    _apply_monthly_like_styles(workbook)

    assert worksheet["B2"].number_format == "0.00%"
    assert worksheet["B2"].protection.locked is False
    assert worksheet["B2"].fill.fgColor.rgb == "FFFFFFFF"

    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    reloaded = load_workbook(output)
    assert reloaded["交易一览"]["B2"].number_format == "0.00%"
    assert reloaded["交易一览"]["B2"].protection.locked is False

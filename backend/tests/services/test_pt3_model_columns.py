"""Regression test: MonthlyReportPT3Calculation must NOT have expense_vat_total column.

Bug history (2026-06-11): expense_vat_total was incorrectly added to PT3 in
task 2, causing INSERT to reference a column that does not exist in the
monthly_report_pt3_calculation table → 500 on recalculate.
"""
from app.models.monthly_report import MonthlyReportPT3Calculation, MonthlyReportPT4Calculation


def test_pt3_does_not_have_expense_vat_total():
    """PT3 模型不应有 expense_vat_total（这是 PT4 的字段）。"""
    column_names = {c.name for c in MonthlyReportPT3Calculation.__table__.columns}
    assert "expense_vat_total" not in column_names, (
        "PT3 模型中误加 expense_vat_total 列。PT3 应只含 income_vat_total 和 "
        "income_sales_with_tax；expense_vat_total 属于 PT4 表。"
    )


def test_pt3_has_income_vat_columns():
    """PT3 应该有 income_vat_total 和 income_sales_with_tax。"""
    column_names = {c.name for c in MonthlyReportPT3Calculation.__table__.columns}
    assert "income_vat_total" in column_names
    assert "income_sales_with_tax" in column_names


def test_pt4_has_expense_vat_total():
    """PT4 应该有 expense_vat_total（用于回款公式）。"""
    column_names = {c.name for c in MonthlyReportPT4Calculation.__table__.columns}
    assert "expense_vat_total" in column_names

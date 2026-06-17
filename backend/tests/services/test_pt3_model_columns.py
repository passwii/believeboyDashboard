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


def test_pt4_does_not_have_income_vat_columns():
    """PT4 一定不能含 income 侧 VAT 列（alembic 160 把它放在 PT3）。

    BEL-125 v3 修复点：API 读路径不能再 `getattr(pt4, "income_vat_total")`
    — 该字段历史上一直不在 PT4 上，访问会 AttributeError，API 永远返回 0。
    这个回归保护锁住"income VAT 的唯一真源是 PT3"的不变量。
    """
    column_names = {c.name for c in MonthlyReportPT4Calculation.__table__.columns}
    assert "income_vat_total" not in column_names, (
        "PT4 表误加 income_vat_total 列。Income-side VAT 必须从 PT3 读，"
        "PT4 只承担 expense-side VAT（expense_vat_total）。"
    )
    assert "income_sales_with_tax" not in column_names, (
        "PT4 表误加 income_sales_with_tax 列。该列属于 PT3（alembic 160）。"
    )

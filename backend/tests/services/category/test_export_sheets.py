"""Tests for category-research Excel export number_format wiring.

These tests cover the entry points in ``app/services/category/export.py``
that were migrated to the shared ``rows_to_sheet`` helper. The contract is:

  - currency columns → 2dp ``$#,##0.00`` (USD)
  - percent columns  → 2dp ``0.00%`` (source is 0..1)
  - integer columns  → ``0`` (no decimals)
  - rating columns   → ``0.00`` (decimal with 2dp but no currency symbol)

Before the migration, percent values were baked into the cell as strings
like ``"33.33%"`` — this broke downstream SUM / AVERAGE because the cell
type was text. After the migration they're floats with a percent format.
"""
from openpyxl import Workbook

from app.services.category.export import (
    _add_brand_sheet,
    _add_kpi_sheet,
    _add_price_band_sheet,
    _add_product_sheet,
    _add_trend_sheet,
)


# --------------------------------------------------------------------------- #
# KPI sheet
# --------------------------------------------------------------------------- #


def test_kpi_sheet_pins_price_to_currency_and_share_to_percent():
    """KPI values are heterogeneous (ints, floats, fractions). The format
    helper picks the right number_format per row based on the key name."""
    wb = Workbook()
    wb.remove(wb.active)
    overview = {
        "kpis": {
            "sample_count": 1234,
            "average_price_usd": 19.99,
            "amazon_share": 0.3333,
        }
    }
    _add_kpi_sheet(wb, overview)
    ws = wb["KPI"]
    # Find each row by its label (column A).
    by_label = {ws.cell(r, 1).value: ws.cell(r, 2) for r in range(1, ws.max_row + 1)}
    # Integer count: no format, value is the raw int.
    assert by_label["sample_count"].value == 1234.0
    assert by_label["sample_count"].number_format == "General"
    # Currency: USD format.
    assert "$" in by_label["average_price_usd"].number_format
    assert by_label["average_price_usd"].value == 19.99
    # Percent: 0..1 fraction with 0.00% format.
    assert by_label["amazon_share"].number_format == "0.00%"
    assert by_label["amazon_share"].value == 0.3333


# --------------------------------------------------------------------------- #
# Brand analysis sheet
# --------------------------------------------------------------------------- #


def test_brand_sheet_writes_share_as_float_not_string():
    """Critical regression guard: previously ``份额`` was written as the
    string ``"33.33%"`` (text cell), which broke SUM/AVERAGE. After the
    migration the value is a float and the cell carries the percent format."""
    wb = Workbook()
    wb.remove(wb.active)
    overview = {
        "brand_sales_share": [
            {"brand": "Acme", "monthly_sales": 1234, "share": 0.3333},
            {"brand": "Beta", "monthly_sales": 0, "share": 0.0},
        ]
    }
    _add_brand_sheet(wb, overview)
    ws = wb["品牌分析"]
    # Header row.
    assert ws.cell(1, 1).value == "品牌"
    assert ws.cell(1, 2).value == "月销量"
    assert ws.cell(1, 3).value == "份额"
    # Data row 1: 份额 is a float, not the string "33.33%".
    assert ws.cell(2, 1).value == "Acme"
    assert ws.cell(2, 2).value == 1234
    assert ws.cell(2, 3).value == 0.3333
    assert isinstance(ws.cell(2, 3).value, float)
    assert ws.cell(2, 3).number_format == "0.00%"
    # 月销量 is integer count, not currency.
    assert ws.cell(2, 2).number_format == "0"


# --------------------------------------------------------------------------- #
# Price band sheet
# --------------------------------------------------------------------------- #


def test_price_band_sheet_formats_share_and_rating():
    wb = Workbook()
    wb.remove(wb.active)
    overview = {
        "price_band_opportunities": [
            {
                "label": "$10-$20",
                "count": 100,
                "monthly_sales": 500,
                "sales_share": 0.5,
                "average_rating": 4.5,
            }
        ]
    }
    _add_price_band_sheet(wb, overview)
    ws = wb["价格带分析"]
    by_label = {ws.cell(1, c).value: c for c in range(1, ws.max_column + 1)}
    # 销量占比 is 0..1 → 0.00%.
    share_col = by_label["销量占比"]
    assert ws.cell(2, share_col).value == 0.5
    assert ws.cell(2, share_col).number_format == "0.00%"
    # 平均评分 is decimal, not currency.
    rating_col = by_label["平均评分"]
    assert ws.cell(2, rating_col).value == 4.5
    assert ws.cell(2, rating_col).number_format == "0.00"
    # Counts are integers, not currency.
    count_col = by_label["样本数"]
    assert ws.cell(2, count_col).number_format == "0"
    sales_col = by_label["月销量"]
    assert ws.cell(2, sales_col).number_format == "0"


# --------------------------------------------------------------------------- #
# Product sheet
# --------------------------------------------------------------------------- #


def test_product_sheet_formats_price_and_counts():
    class _Product:
        def __init__(self, asin, brand, seller, price, monthly_sales, rating, review_count):
            self.asin = asin
            self.brand = brand
            self.seller = seller
            self.price_usd = price
            self.monthly_sales = monthly_sales
            self.rating = rating
            self.review_count = review_count

    wb = Workbook()
    wb.remove(wb.active)
    products = [
        _Product("A1", "Acme", "Seller1", 19.99, 100, 4.5, 50),
    ]
    _add_product_sheet(wb, products)
    ws = wb["产品明细"]
    by_label = {ws.cell(1, c).value: c for c in range(1, ws.max_column + 1)}
    assert "$" in ws.cell(2, by_label["价格"]).number_format
    assert ws.cell(2, by_label["价格"]).value == 19.99
    assert ws.cell(2, by_label["月销量"]).number_format == "0"
    assert ws.cell(2, by_label["评分"]).number_format == "0.00"
    assert ws.cell(2, by_label["评论数"]).number_format == "0"


def test_product_sheet_with_empty_products_creates_blank_sheet():
    """Empty product list still creates a (blank) sheet — matches the
    pre-migration behaviour so callers iterating ``wb.sheetnames`` don't
    see a missing sheet."""
    wb = Workbook()
    wb.remove(wb.active)
    _add_product_sheet(wb, [])
    assert "产品明细" in wb.sheetnames
    assert wb["产品明细"].max_row == 1  # only the default empty row


# --------------------------------------------------------------------------- #
# Trend sheet
# --------------------------------------------------------------------------- #


def test_trend_sheet_formats_count_as_integer():
    wb = Workbook()
    wb.remove(wb.active)
    class _Trend:
        def __init__(self, asin, year_month, monthly_sales):
            self.asin = asin
            self.year_month = year_month
            self.monthly_sales = monthly_sales

    trends = [_Trend("A1", "2026-07", 123)]
    _add_trend_sheet(wb, trends)
    ws = wb["趋势明细"]
    by_label = {ws.cell(1, c).value: c for c in range(1, ws.max_column + 1)}
    assert ws.cell(2, by_label["月销量"]).number_format == "0"
    assert ws.cell(2, by_label["月销量"]).value == 123


def test_trend_sheet_with_empty_trends_creates_blank_sheet():
    wb = Workbook()
    wb.remove(wb.active)
    _add_trend_sheet(wb, [])
    assert "趋势明细" in wb.sheetnames
    assert wb["趋势明细"].max_row == 1
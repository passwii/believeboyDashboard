"""Unit tests for Other transaction fees / refunds accounting (BEL-127 follow-up).

回归 UK 月报 PT3 与 Amazon PDF 差异：``expense_other_transaction_fees``
应等于 Order 行 ``other transaction fees`` 列之和，
``expense_other_transaction_fee_refunds`` 应等于 Refund 行该列之和。

之前两个值被硬编码为 ``Decimal("0")``，导致 PT3 比 PDF 少计这两块
（如 2026-05 UK 报表差 -6.46 / 0.04）。
"""
from decimal import Decimal

from app.services.payment.classifier import classify_rows
from app.services.payment.financial import compute_metrics


def _uk_order_row(product_sales: str, otf: str) -> dict:
    return {
        "type": "Order",
        "fulfillment": "Amazon",
        "description": "GOBOBE Plush Dog Bed Small",
        "product sales": product_sales,
        "product sales tax": str(
            (Decimal(product_sales) * Decimal("0.2")).quantize(Decimal("0.01"))
        ),
        "selling fees": "-2",
        "fba fees": "-3",
        "shipping credits": "0",
        "promotional rebates": "0",
        "gift wrap credits": "0",
        "other": "0",
        "other transaction fees": otf,
        "total": str(
            (Decimal(product_sales) + Decimal(otf) - Decimal("5")).quantize(
                Decimal("0.01")
            )
        ),
    }


def _uk_refund_row(product_sales: str, otf: str) -> dict:
    return {
        "type": "Refund",
        "fulfillment": "Amazon",
        "description": "GOBOBE Plush Dog Bed Medium",
        "product sales": product_sales,
        "product sales tax": str(
            (Decimal(product_sales) * Decimal("0.2")).quantize(Decimal("0.01"))
        ),
        "selling fees": "0.4",
        "fba fees": "0.6",
        "shipping credits": "0",
        "promotional rebates": "0",
        "gift wrap credits": "0",
        "other": "0",
        "other transaction fees": otf,
        "total": str(
            (Decimal(product_sales) + Decimal(otf)).quantize(Decimal("0.01"))
        ),
    }


def test_other_transaction_fees_summed_from_order_rows():
    """Order 行的 other transaction fees 列之和 → expense_other_transaction_fees。

    复刻 2026-05 UK 报表口径：75 单合计 -6.46（这里用 3 单抽样验证公式正确）。
    """
    rows = [
        _uk_order_row("10.00", "-0.08"),
        _uk_order_row("11.76", "-0.08"),
        _uk_order_row("12.32", "-0.16"),
    ]
    result = compute_metrics(classify_rows(rows), country="UK")

    pt3 = result["pt3"]
    # -0.08 + -0.08 + -0.16 = -0.32
    assert pt3["expense_other_transaction_fees"] == Decimal("-0.32")
    # Refund 行为空 → 退款杂费为 0
    assert pt3["expense_other_transaction_fee_refunds"] == Decimal("0")


def test_other_transaction_fee_refunds_summed_from_refund_rows():
    """Refund 行的 other transaction fees 列之和 → expense_other_transaction_fee_refunds。

    复刻 2026-05 UK 报表口径：2 笔退款合计 0.04。
    """
    rows = [
        _uk_refund_row("-15.80", "0.02"),
        _uk_refund_row("-14.28", "0.02"),
    ]
    result = compute_metrics(classify_rows(rows), country="UK")

    pt3 = result["pt3"]
    # 0.02 + 0.02 = 0.04
    assert pt3["expense_other_transaction_fee_refunds"] == Decimal("0.04")
    # Order 行为空 → 杂费为 0
    assert pt3["expense_other_transaction_fees"] == Decimal("0")


def test_other_transaction_fees_combined_orders_and_refunds():
    """Order 与 Refund 混合：两块独立求和（复刻 2026-05 UK 报表真实差异值）。

    这是 BEL-127 follow-up 报告的差异场景：PDF -6.46 / 0.04 vs PT3 0。
    """
    rows = [
        _uk_order_row("10.00", "-0.08"),
        _uk_order_row("12.32", "-0.08"),
        _uk_refund_row("-15.80", "0.02"),
    ]
    result = compute_metrics(classify_rows(rows), country="UK")

    pt3 = result["pt3"]
    assert pt3["expense_other_transaction_fees"] == Decimal("-0.16")
    assert pt3["expense_other_transaction_fee_refunds"] == Decimal("0.02")


def test_advertising_other_transaction_fees_not_double_counted():
    """Service Fee(Cost of Advertising) 的 otf 不得计入 expense_other_transaction_fees。

    广告费的 other transaction fees 已通过 advertising → expense_cost_of_advertising
    单独计入，必须避免重复扣款。
    """
    rows = [
        _uk_order_row("10.00", "-0.08"),
        {
            "type": "Service Fee",
            "fulfillment": "",
            "description": "Cost of Advertising",
            "product sales": "0",
            "product sales tax": "0",
            "selling fees": "0",
            "fba fees": "0",
            "shipping credits": "0",
            "promotional rebates": "0",
            "gift wrap credits": "0",
            "other": "0",
            "other transaction fees": "-11.02",
            "total": "-11.02",
        },
    ]
    result = compute_metrics(classify_rows(rows), country="UK")

    pt3 = result["pt3"]
    # 只算 Order 的 -0.08，广告的 -11.02 不进这里
    assert pt3["expense_other_transaction_fees"] == Decimal("-0.08")
    # 广告单独计入
    assert pt3["expense_cost_of_advertising"] == Decimal("-11.02")


def test_expense_total_includes_other_transaction_fees():
    """expense_total 必须把 Other transaction fees 算进合计。"""
    rows = [
        _uk_order_row("10.00", "-0.50"),
    ]
    result = compute_metrics(classify_rows(rows), country="UK")

    pt3 = result["pt3"]
    # expense_other_transaction_fees 不为 0 → expense_total 必须体现这块
    assert pt3["expense_other_transaction_fees"] == Decimal("-0.50")
    # expense_total 至少包含 -0.50
    assert pt3["expense_total"] <= Decimal("-0.50")

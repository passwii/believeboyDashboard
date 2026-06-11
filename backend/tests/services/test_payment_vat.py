"""Unit tests for VAT metrics (US/DE/UK) in payment.financial module."""
from decimal import Decimal

from app.services.payment.classifier import classify_rows
from app.services.payment.financial import (
    _compute_vat_metrics,
    compute_metrics,
)


# ── _compute_vat_metrics 单元测试 ────────────────────────────────────────────


def test_vat_metrics_us_returns_zero():
    """US 报表：product_sales_tax 通常为 0，新口径与原版完全一致。"""
    result = _compute_vat_metrics(
        classified={"order": [{"product sales": "10", "product sales tax": "0"}]},
        country="US",
    )
    assert result["income_vat_total"] == Decimal("0")
    assert result["income_sales_with_tax"] == Decimal("0")
    assert result["expense_vat_total"] == Decimal("0")


def test_vat_metrics_us_lowercase_country_normalized():
    """country 大小写不敏感：'us'、'US' 同义。"""
    result = _compute_vat_metrics(
        classified={"order": [], "refund": []},
        country="us",
    )
    assert result["income_vat_total"] == Decimal("0")


def test_vat_metrics_de_orders_only():
    """DE 纯订单：income_vat_total = sum(product_sales_tax)。"""
    result = _compute_vat_metrics(
        classified={
            "order": [
                {"product sales": "15.82", "product sales tax": "3.17"},
                {"product sales": "20.99", "product sales tax": "0"},
            ],
            "refund": [],
        },
        country="DE",
    )
    assert result["income_vat_total"] == Decimal("3.17")
    # 含税 = 15.82 + 3.17 + 20.99 + 0 = 39.98
    assert result["income_sales_with_tax"] == Decimal("39.98")
    assert result["expense_vat_total"] == Decimal("3.17")


def test_vat_metrics_uk_refund_negative_tax():
    """UK 退款：product_sales 为负、product_sales_tax 也为负。"""
    result = _compute_vat_metrics(
        classified={
            "order": [],
            "refund": [
                {"product sales": "-17.49", "product sales tax": "-3.50"},
            ],
        },
        country="UK",
    )
    # VAT = -3.50
    assert result["income_vat_total"] == Decimal("-3.50")
    # 含税 = -17.49 + -3.50 = -20.99
    assert result["income_sales_with_tax"] == Decimal("-20.99")


def test_vat_metrics_mixed_order_and_refund():
    """Order 与 Refund 同时存在时求和（退款为负，自然抵消）。"""
    result = _compute_vat_metrics(
        classified={
            "order": [{"product sales": "100", "product sales tax": "20"}],
            "refund": [{"product sales": "-20", "product sales tax": "-4"}],
        },
        country="UK",
    )
    # VAT = 20 + (-4) = 16
    assert result["income_vat_total"] == Decimal("16")
    # 含税 = (100+20) + (-20-4) = 96
    assert result["income_sales_with_tax"] == Decimal("96")


# ── compute_metrics 端到端测试 ──────────────────────────────────────────────


def test_compute_metrics_us_unchanged():
    """US 报表：income_total 与 amazon_pay_back 公式不变。"""
    rows = [
        {
            "type": "Order",
            "fulfillment": "Amazon",
            "product sales": "100",
            "product sales tax": "0",
            "selling fees": "-15",
            "fba fees": "-5",
            "shipping credits": "0",
            "promotional rebates": "0",
            "gift wrap credits": "0",
            "other": "0",
            "total": "80",
            "description": "",
        },
    ]
    classified = classify_rows(rows)
    result = compute_metrics(classified, country="US")

    pt4 = result["pt4"]
    # US：income_total 不含 VAT
    assert pt4["income_total"] == Decimal("100")
    assert pt4["expense_vat_total"] == Decimal("0")
    # 回款 = 100 + (-15) + (-5) = 80
    assert pt4["amazon_pay_back"] == Decimal("80")


def test_compute_metrics_de_with_vat():
    """DE 报表：income_total 含 VAT，回款公式走新口径。"""
    rows = [
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
    classified = classify_rows(rows)
    result = compute_metrics(classified, country="DE")

    pt4 = result["pt4"]
    # DE：income_total = 100 + 19 = 119（gross）
    assert pt4["income_total"] == Decimal("119")
    assert pt4["expense_vat_total"] == Decimal("19")
    # 回款 = 119 + (-15) + (-5) - 19 = 80（gross 化前后期望值与原 net 公式相同）
    assert pt4["amazon_pay_back"] == Decimal("80")

    pt3 = result["pt3"]
    assert pt3["income_vat_total"] == Decimal("19")
    assert pt3["income_sales_with_tax"] == Decimal("119")

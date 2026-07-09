"""Unit tests for VAT metrics (US/DE/UK) in payment.financial module."""
from decimal import Decimal

from app.services.payment.classifier import classify_rows
from app.services.payment.financial import (
    _compute_vat_metrics,
    compute_metrics,
)


# ── _compute_vat_metrics 单元测试 ────────────────────────────────────────────


def test_vat_metrics_us_returns_zero():
    """US 报表：product_sales_tax 为 0，income_vat_total 必为 0。

    v2 行为变更（BEL-125）：``income_sales_with_tax`` 不再 hardcode 0，
    而是 ``sum(product_sales)``（= net），便于前端无分支消费。
    """
    result = _compute_vat_metrics(
        classified={"order": [{"product sales": "10", "product sales tax": "0"}]},
        country="US",
    )
    assert result["income_vat_total"] == Decimal("0")
    assert result["income_sales_with_tax"] == Decimal("10")
    assert result["expense_vat_total"] == Decimal("0")


def test_vat_metrics_us_orders_and_refunds_real_sum():
    """US：income_sales_with_tax = 订单 net + 退款 net（退款为负自然抵消）。"""
    result = _compute_vat_metrics(
        classified={
            "order": [{"product sales": "100", "product sales tax": "0"}],
            "refund": [{"product sales": "-20", "product sales tax": "0"}],
        },
        country="US",
    )
    assert result["income_vat_total"] == Decimal("0")
    assert result["income_sales_with_tax"] == Decimal("80")
    assert result["expense_vat_total"] == Decimal("0")


def test_vat_metrics_us_lowercase_country_normalized():
    """country 大小写不敏感：'us'、'US' 同义。"""
    result = _compute_vat_metrics(
        classified={"order": [], "refund": []},
        country="us",
    )
    assert result["income_vat_total"] == Decimal("0")


def test_vat_metrics_de_orders_only():
    """DE 纯订单：income_vat_total = sum(marketplace_withheld_tax)（订单为负）。

    口径自 vX 起从 product_sales_tax 切到 marketplace withheld tax（DE 列名
    "Einbehaltene Steuer auf Marketplace"）；Amazon 报表中此列与
    product_sales_tax 符号相反，故订单的聚合值为负，直接存储原始符号。
    """
    result = _compute_vat_metrics(
        classified={
            "order": [
                {"product sales": "15.82", "marketplace withheld tax": "-3.17"},
                {"product sales": "20.99", "marketplace withheld tax": "0"},
            ],
            "refund": [],
        },
        country="DE",
    )
    # VAT = (-3.17 + 0) = -3.17（保留原始 marketplace withheld tax 符号）
    assert result["income_vat_total"] == Decimal("-3.17")
    # gross = net_sales - income_vat_total = 36.81 - (-3.17) = 39.98（= 旧口径 gross）
    assert result["income_sales_with_tax"] == Decimal("39.98")
    assert result["expense_vat_total"] == Decimal("-3.17")


def test_vat_metrics_uk_refund_negative_tax():
    """UK 退款：product_sales 为负、marketplace_withheld_tax 符号反向为正。

    退款时 Amazon 把代扣的税退回，故 withheld 列在退款行为正；直接存储该值。
    """
    result = _compute_vat_metrics(
        classified={
            "order": [],
            "refund": [
                {"product sales": "-17.49", "marketplace withheld tax": "3.50"},
            ],
        },
        country="UK",
    )
    # VAT = +3.50（保留原始 marketplace withheld tax 符号；退款代扣税回流）
    assert result["income_vat_total"] == Decimal("3.50")
    # 含税 = net_sales - income_vat_total = -17.49 - 3.50 = -20.99（= 旧口径）
    assert result["income_sales_with_tax"] == Decimal("-20.99")


def test_vat_metrics_mixed_order_and_refund():
    """Order 与 Refund 同时存在时求和（退款为负，自然抵消）。"""
    result = _compute_vat_metrics(
        classified={
            "order": [{"product sales": "100", "marketplace withheld tax": "-20"}],
            "refund": [{"product sales": "-20", "marketplace withheld tax": "4"}],
        },
        country="UK",
    )
    # VAT = (-20 + 4) = -16（保留原始符号；订单负、退款正，求和后为负）
    assert result["income_vat_total"] == Decimal("-16")
    # gross = net_sales - income_vat_total = (100-20) - (-16) = 80 + 16 = 96
    assert result["income_sales_with_tax"] == Decimal("96")


# ── compute_metrics 端到端测试 ──────────────────────────────────────────────


def test_compute_metrics_us_unchanged():
    """US 报表：income_total 与 amazon_pay_back 公式不变。

    v2 行为变更（BEL-125）：``income_sales_with_tax`` 现在等于 net，
    端到端检查该字段也是 net（让前端无分支消费 sales_with_tax）。
    """
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

    pt3 = result["pt3"]
    # v2：US 端到端 sales_with_tax = net
    assert pt3["income_sales_with_tax"] == Decimal("100")
    assert pt3["income_vat_total"] == Decimal("0")


def test_compute_metrics_de_with_vat():
    """DE 报表：income_total 走 marketplace withheld tax 口径，回款公式不变。

    口径自 vX 起从 product_sales_tax 切到 marketplace withheld tax：
    - 报表中 withheld = -19 → income_vat_total = -19（保留原始符号，订单为负）
    - income_total = net - income_vat_total = 100 - (-19) = 119（= gross，数值不变）
    - expense_vat_total 同步为负（-19）
    - amazon_pay_back 公式收入+支出+expense_vat_total（加负数）= 80 不变
    - income_sales_with_tax = net − withheld = 100 − (-19) = 119（= gross 不变）
    """
    rows = [
        {
            "type": "Order",
            "fulfillment": "Amazon",
            "product sales": "100",
            "marketplace withheld tax": "-19",
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
    # DE：income_total = 100 - (-19) = 119（net - income_vat_total，数值不变）
    assert pt4["income_total"] == Decimal("119")
    assert pt4["expense_vat_total"] == Decimal("-19")
    # 回款 = 119 + (-15) + (-5) + (-19) = 80（加负数等价于减 |VAT|，数值不变）
    assert pt4["amazon_pay_back"] == Decimal("80")

    pt3 = result["pt3"]
    assert pt3["income_vat_total"] == Decimal("-19")
    assert pt3["income_sales_with_tax"] == Decimal("119")

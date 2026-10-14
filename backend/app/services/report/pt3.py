"""PT3 detailed accounting calculation module.

Builds detailed income/expense rows from MonthlyReportPT3Calculation model.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    MonthlyReportPT3Calculation,
    MonthlyReportTransaction,
)
from app.services.report.utils import (
    _parse_transaction_datetime,
    _round2,
    _to_decimal,
    _to_float,
    normalize_text,
)
from app.utils.country import get_currency

# Discriminator for the structured layout produced by `_build_accounting_rows`.
# - "detail" : an income/expense line item (regular row).
# - "spacer" : a blank separator row inserted between the detail block and the
#              Total row so the totals read as a visual summary.
# - "total"  : the bottom row carrying Total_Income and Total_Expense on the
#              same line. Left half is income, right half is expense.
AccountingRowKind = Literal["detail", "spacer", "total"]


def _pt3_float(pt3: MonthlyReportPT3Calculation, key: str) -> float:
    """Extract float value from PT3 calculation."""
    return _to_float(getattr(pt3, key, 0))


def _build_accounting_rows(
    pt3: MonthlyReportPT3Calculation,
    *,
    country: str | None = None,
) -> list[dict[str, Any]]:
    """Build dual-column income/expense rows from PT3 calculation.

    The output is a single source of truth for both the frontend table and the
    Excel "报表核算" sheet. It is structured with a `kind` discriminator so the
    view layer can render:

        ┌─ income_pad blank income rows (pads to the longer expense side) ─┐
        │ 16 income detail rows  ║  19 expense detail rows  (right-aligned)   │
        │ spacer row (1 blank row separating details from totals)             │
        │ Total_Income row  ║  Total_Expense row  (same line)                 │
        └─────────────────────────────────────────────────────────────────────┘

    Args:
        pt3: MonthlyReportPT3Calculation model instance
        country: Country code (US/DE/UK). Used to stamp the local
            currency ISO code onto each row for the frontend to render
            the correct symbol/label. When omitted, defaults to USD
            (the historical behavior).

    Returns:
        List of dicts with income_en, income_zh, income_amount_usd, income_source,
        expense_en, expense_zh, expense_amount_usd, expense_source,
        currency_code, and kind keys.
    """
    currency_code = get_currency(country) if country else "USD"
    # Build the structured row list. The output is the single source of truth
    # for both the frontend table and the Excel "报表核算" sheet.
    #
    # Layout (21 rows total for the current 16 income + 19 expense detail):
    #   rows 0..2       income pad (blank income, real expense lines 0..2)
    #   rows 3..18      16 income detail rows aligned with expense lines 3..18
    #   row 19          spacer (blank, separates details from totals)
    #   row 20          total row: Total_Income on the left, Total_Expense on
    #                   the right, on the same visual line
    income_lines = [
        (
            "Product sales (non-FBA)",
            "销售额（非FBA）",
            _pt3_float(pt3, "income_product_sales_non_fba"),
            "FBM 订单-订单金额",
        ),
        (
            "Product sale refunds (non-FBA)",
            "销售额退款（非FBA）",
            _pt3_float(pt3, "income_product_sale_refunds_non_fba"),
            "FBM 退款-订单金额",
        ),
        (
            "FBA product sales",
            "销售额（FBA）",
            _pt3_float(pt3, "income_fba_product_sales"),
            "FBA 订单-订单金额",
        ),
        (
            "FBA product sale refunds",
            "销售额退款（FBA）",
            _pt3_float(pt3, "income_fba_product_sale_refunds"),
            "FBA 退款-订单金额 + 其他金额",
        ),
        (
            "FBA inventory credit",
            "FBA库存赔偿（FBA）",
            _pt3_float(pt3, "income_fba_inventory_credit"),
            "FBA库存赔偿-总计",
        ),
        (
            "FBA liquidation proceeds",
            "FBA清算收入",
            _pt3_float(pt3, "income_fba_liquidation_proceeds"),
            "清算费用-订单金额",
        ),
        (
            "Shipping credits",
            "运费收入",
            _pt3_float(pt3, "income_shipping_credits"),
            "所有订单-运费金额",
        ),
        (
            "Shipping credit refunds",
            "运费退款",
            _pt3_float(pt3, "income_shipping_credit_refunds"),
            "所有退款-运费金额",
        ),
        (
            "Gift wrap credits",
            "礼品包装收入",
            _pt3_float(pt3, "income_gift_wrap_credits"),
            "所有订单-礼品包装金额",
        ),
        (
            "Gift wrap credit refunds",
            "礼品包装退款",
            _pt3_float(pt3, "income_gift_wrap_credits_refunds"),
            "所有退款-礼品包装金额",
        ),
        (
            "Promotional rebates",
            "促销折扣",
            _pt3_float(pt3, "income_promotional_rebates"),
            "所有订单-促销折扣金额",
        ),
        (
            "Promotional rebate refunds",
            "促销折扣退款",
            _pt3_float(pt3, "income_promotional_rebate_refunds"),
            "所有退款-促销折扣金额",
        ),
        (
            "A-to-z Guarantee claims",
            "A-to-z保障索赔",
            _pt3_float(pt3, "income_a_to_z_guarantee_claims"),
            "",
        ),
        (
            "Chargebacks",
            "拒付退款",
            _pt3_float(pt3, "income_chargebacks"),
            "拒付退款-总计",
        ),
        (
            "SAFE-T reimbursement",
            "SAFE-T赔偿",
            _pt3_float(pt3, "income_safe_t_reimbursement"),
            "",
        ),
        (
            "Product sales tax (gross)",
            "销售税（gross）",
            _pt3_float(pt3, "income_vat_total"),
            "所有订单/退款-产品销售税",
        ),
    ]

    expense_lines = [
        (
            "Seller fulfilled selling fees",
            "卖家自配送销售佣金",
            _pt3_float(pt3, "expense_seller_fulfilled_selling_fees"),
            "FBM 订单-销售佣金",
        ),
        (
            "FBA selling fees",
            "FBA销售佣金",
            _pt3_float(pt3, "expense_fba_selling_fees"),
            "FBA 订单-销售佣金",
        ),
        (
            "Selling fee refunds",
            "销售佣金退款",
            _pt3_float(pt3, "expense_selling_fee_refunds"),
            "所有退款-销售佣金 + 退款管理费",
        ),
        (
            "FBA transaction fees",
            "FBA派送费",
            _pt3_float(pt3, "expense_fba_transaction_fees"),
            "FBA 订单 - 派送费",
        ),
        (
            "FBA transaction fee refunds",
            "FBA派送费退款",
            _pt3_float(pt3, "expense_fba_transaction_fee_refunds"),
            "FBA 退款 - 派送费 + 测量费",
        ),
        (
            "Other transaction fees",
            "其他交易费用",
            _pt3_float(pt3, "expense_other_transaction_fees"),
            "",
        ),
        (
            "Other transaction fee refunds",
            "其他交易费用退款",
            _pt3_float(pt3, "expense_other_transaction_fee_refunds"),
            "",
        ),
        (
            "FBA inventory and inbound services fees",
            "FBA库存和入库服务费",
            _pt3_float(pt3, "expense_fba_inventory_and_inbound_services_fees"),
            "FBA仓储及入库服务费 - 总计",
        ),
        (
            "Shipping label purchases",
            "购买配送标签",
            _pt3_float(pt3, "expense_shipping_label_purchases"),
            "",
        ),
        (
            "Shipping label refunds",
            "配送标签退款",
            _pt3_float(pt3, "expense_shipping_label_refunds"),
            "",
        ),
        (
            "Carrier shipping label adjustments",
            "承运商配送标签调整",
            _pt3_float(pt3, "expense_carrier_shipping_label_adjustments"),
            "",
        ),
        (
            "Service fees",
            "服务费",
            _pt3_float(pt3, "expense_service_fees"),
            "服务费（不含广告）-总计",
        ),
        (
            "Refund administration fees",
            "退款管理费",
            _pt3_float(pt3, "expense_refund_administration_fees"),
            "合并在销售佣金退款中扣除",
        ),
        (
            "Adjustments",
            "调整项",
            _pt3_float(pt3, "expense_adjustments"),
            "其他赔偿调整-总计",
        ),
        (
            "Cost of Advertising",
            "广告成本",
            _pt3_float(pt3, "expense_cost_of_advertising"),
            "广告费-总计",
        ),
        (
            "Refund for Advertiser",
            "广告商退款",
            _pt3_float(pt3, "expense_refund_for_advertiser"),
            "广告退款-总计",
        ),
        (
            "Liquidations fees",
            "清算处理费",
            _pt3_float(pt3, "expense_liquidations_fees"),
            "清算费用-其他交易费用",
        ),
        ("Receivables", "应收账款", _pt3_float(pt3, "expense_receivables"), ""),
        ("Deductions", "扣款", _pt3_float(pt3, "expense_deductions"), ""),
        (
            "Amazon Shipping Charge Adjustments",
            "亚马逊配送运费调整",
            _pt3_float(pt3, "expense_amazon_shipping_charge_adjustments"),
            "",
        ),
    ]

    income_detail_count = len(income_lines)
    expense_detail_count = len(expense_lines)
    # Pad the shorter side (income) at the top with blank income rows so the
    # detail blocks share a common baseline, and the two Total rows align at
    # the bottom of the table.
    income_pad = max(0, expense_detail_count - income_detail_count)

    rows: list[dict[str, Any]] = []

    def _detail_row(
        in_line: tuple[str, str, float, str],
        ex_line: tuple[str, str, float, str],
    ) -> dict[str, Any]:
        return {
            "income_en": in_line[0],
            "income_zh": in_line[1],
            "income_amount_usd": in_line[2],
            "income_source": in_line[3],
            "expense_en": ex_line[0],
            "expense_zh": ex_line[1],
            "expense_amount_usd": ex_line[2],
            "expense_source": ex_line[3],
            "currency_code": currency_code,
            "kind": "detail",
        }

    # Top pad: blank income, real expense. This satisfies the requirement
    # that "Total_Income 这上面不够的就用空白填充".
    for pad_idx in range(income_pad):
        rows.append(_detail_row(("", "", 0.0, ""), expense_lines[pad_idx]))

    # Aligned detail block: one row per income line item, with the expense
    # column offset by `income_pad` so the bottom of the two blocks aligns.
    for in_idx in range(income_detail_count):
        ex_idx = income_pad + in_idx
        ex_line = (
            expense_lines[ex_idx] if ex_idx < expense_detail_count else ("", "", 0.0, "")
        )
        rows.append(_detail_row(income_lines[in_idx], ex_line))

    # Spacer: one blank row separating the details from the totals so the
    # totals read as a visual summary.
    rows.append(
        {
            "income_en": "",
            "income_zh": "",
            "income_amount_usd": 0.0,
            "income_source": "",
            "expense_en": "",
            "expense_zh": "",
            "expense_amount_usd": 0.0,
            "expense_source": "",
            "currency_code": currency_code,
            "kind": "spacer",
        }
    )

    # Total row: Total_Income on the left, Total_Expense on the right, on the
    # same visual line.
    rows.append(
        {
            "income_en": "Total_Income",
            "income_zh": "合计销售额",
            "income_amount_usd": _pt3_float(pt3, "income_total"),
            "income_source": "",
            "expense_en": "Total_Expense",
            "expense_zh": "合计费用",
            "expense_amount_usd": _pt3_float(pt3, "expense_total"),
            "expense_source": "",
            "currency_code": currency_code,
            "kind": "total",
        }
    )

    return rows


def _load_transaction_raw_rows(
    db: Session, *, report_id: int
) -> list[dict[str, object]]:
    """Load raw transaction rows for a report.

    Args:
        db: Database session
        report_id: Monthly report ID

    Returns:
        List of dicts representing raw transaction data
    """
    transactions = (
        db.execute(
            select(MonthlyReportTransaction)
            .where(MonthlyReportTransaction.report_id == report_id)
            .order_by(MonthlyReportTransaction.source_row_no.asc())
        )
        .scalars()
        .all()
    )
    rows: list[dict[str, object]] = []
    for tx in transactions:
        raw = dict(tx.raw_row or {})
        if "quantity" not in raw:
            raw["quantity"] = tx.quantity
        rows.append(raw)
    return rows


def _classify_monthly_rows(
    all_rows: list[dict[str, object]],
) -> dict[str, list[dict[str, object]]]:
    """Classify transaction rows into categories.

    Args:
        all_rows: List of raw transaction dicts

    Returns:
        Dict with categorized row lists:
        - order, refund, chargeback_refund, liquidation, fba_inventory_fee
        - fba_transaction_fees, fba_order, fbm_order, fba_refund, fbm_refund
        - adjustment_income, adjustment_expense, advertising, service_refund_for_advertiser
    """
    from app.utils.payment_locale import (
        is_fba_storage_fee,
        normalize_payment_description,
        normalize_payment_type,
    )
    classified: dict[str, list[dict[str, object]]] = {
        "order": [],
        "refund": [],
        "chargeback_refund": [],
        "liquidation": [],
        "fba_inventory_fee": [],
        "amazon_fees_and_service_fee_without_ad": [],
        "fba_transaction_fees": [],
        # "FBA Transaction Fees" 类型里描述为仓储（storage）的行（如 "FBA
        # Inventory Storage Fee"）。与 classifier.py 保持同一拆分口径，供导出明细表使用。
        "fba_inventory_and_inbound_fees": [],
        "fba_order": [],
        "fbm_order": [],
        "fba_refund": [],
        "fbm_refund": [],
        "adjustment_income": [],
        "adjustment_expense": [],
        "advertising": [],
        "service_refund_for_advertiser": [],
    }
    adjustment_expense_descriptions = {
        "FBA Inventory Reimbursement - General Adjustment",
        "Non-subscription Fee Adjustment",
        "Other",
        "Buyer Recharge",
    }
    ad_excluded_descriptions = {"Cost of Advertising", "Refund for Advertiser"}

    for row in all_rows:
        # Normalise raw type/description to canonical English so the
        # accounting-detail export works on historical DE data whose
        # raw_row was stored with raw German values (pre-alias).
        row_type = normalize_payment_type(str(row.get("type", "")).strip())
        description = normalize_payment_description(
            str(row.get("description", "")).strip()
        )
        fulfillment = str(row.get("fulfillment", "")).strip()

        if row_type == "Order":
            classified["order"].append(row)
            if fulfillment == "Amazon":
                classified["fba_order"].append(row)
            elif fulfillment == "Seller":
                classified["fbm_order"].append(row)
            continue
        if row_type == "Refund":
            classified["refund"].append(row)
            if fulfillment == "Amazon":
                classified["fba_refund"].append(row)
            elif fulfillment == "Seller":
                classified["fbm_refund"].append(row)
            continue
        if row_type == "Chargeback Refund":
            classified["chargeback_refund"].append(row)
            continue
        if row_type == "Liquidations":
            classified["liquidation"].append(row)
            continue
        if row_type == "FBA Inventory Fee":
            classified["fba_inventory_fee"].append(row)
            continue
        if row_type == "FBA Transaction Fees":
            if is_fba_storage_fee(description):
                classified["fba_inventory_and_inbound_fees"].append(row)
            else:
                classified["fba_transaction_fees"].append(row)
            continue
        if row_type == "Amazon Fees - Reversal":
            if description not in ad_excluded_descriptions:
                classified["amazon_fees_and_service_fee_without_ad"].append(row)
            continue
        if row_type == "Adjustment":
            if description in adjustment_expense_descriptions:
                classified["adjustment_expense"].append(row)
            else:
                classified["adjustment_income"].append(row)
            continue
        if row_type in ("Amazon Fees", "Amazon Fees - Correction", "Service Fee"):
            if description not in ad_excluded_descriptions:
                classified["amazon_fees_and_service_fee_without_ad"].append(row)
            if row_type == "Service Fee" and description == "Cost of Advertising":
                classified["advertising"].append(row)
            elif row_type == "Service Fee" and description == "Refund for Advertiser":
                classified["service_refund_for_advertiser"].append(row)
            continue
    return classified


def _build_transaction_payloads(
    *,
    report_id: int,
    project_name: str,
    report_month: str,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build transaction payloads from CSV rows.

    Args:
        report_id: Monthly report ID
        project_name: Project name
        report_month: Report month YYYY-MM
        rows: List of transaction dicts from CSV

    Returns:
        List of dicts ready for database insertion
    """
    payloads: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        payloads.append(
            {
                "report_id": report_id,
                "project_name": project_name,
                "report_month": report_month,
                "source_row_no": index,
                "transaction_date": _parse_transaction_datetime(row.get("date/time")),
                "settlement_id": normalize_text(row.get("settlement id")),
                "transaction_type": normalize_text(row.get("type")) or "",
                "order_id": normalize_text(row.get("order id")),
                "sku": normalize_text(row.get("sku")),
                "description": normalize_text(row.get("description")),
                "quantity": int(_to_decimal(row.get("quantity"))),
                "marketplace": normalize_text(row.get("marketplace")),
                "account_type": normalize_text(row.get("account type")),
                "fulfillment": normalize_text(row.get("fulfillment")),
                "order_city": normalize_text(row.get("order city")),
                "order_state": normalize_text(row.get("order state")),
                "order_postal": normalize_text(row.get("order postal")),
                "tax_collection_model": normalize_text(row.get("tax collection model")),
                "product_sales": _round2(_to_decimal(row.get("product sales"))),
                "product_sales_tax": _round2(_to_decimal(row.get("product sales tax"))),
                "shipping_credits": _round2(_to_decimal(row.get("shipping credits"))),
                "shipping_credits_tax": _round2(
                    _to_decimal(row.get("shipping credits tax"))
                ),
                "gift_wrap_credits": _round2(_to_decimal(row.get("gift wrap credits"))),
                "gift_wrap_credits_tax": _round2(
                    _to_decimal(row.get("giftwrap credits tax"))
                ),
                "regulatory_fee": _round2(_to_decimal(row.get("Regulatory Fee"))),
                "regulatory_fee_tax": _round2(
                    _to_decimal(row.get("Tax On Regulatory Fee"))
                ),
                "promotional_rebates": _round2(
                    _to_decimal(row.get("promotional rebates"))
                ),
                "promotional_rebates_tax": _round2(
                    _to_decimal(row.get("promotional rebates tax"))
                ),
                "marketplace_withheld_tax": _round2(
                    _to_decimal(row.get("marketplace withheld tax"))
                ),
                "selling_fees": _round2(_to_decimal(row.get("selling fees"))),
                "fba_fees": _round2(_to_decimal(row.get("fba fees"))),
                "other_transaction_fees": _round2(
                    _to_decimal(row.get("other transaction fees"))
                ),
                "other_amount": _round2(_to_decimal(row.get("other"))),
                "total": _round2(_to_decimal(row.get("total"))),
                "raw_row": {
                    str(k): "" if v is None else str(v) for k, v in row.items()
                },
            }
        )
    return payloads


def _normalize_pt3_payload(pt3: dict[str, Any]) -> dict[str, Any]:
    """Normalize PT3 payload with proper rounding.

    Args:
        pt3: Raw PT3 dict

    Returns:
        Normalized dict with Decimal values
    """
    payload = {key: _round2(_to_decimal(value)) for key, value in pt3.items()}
    if "advertising_percentage" in payload:
        payload["advertising_percentage"] = _to_decimal(
            pt3["advertising_percentage"]
        ).quantize(Decimal("0.0001"))
    else:
        payload["advertising_percentage"] = Decimal("0")
    return payload


__all__ = [
    "AccountingRowKind",
    "_build_accounting_rows",
    "_build_transaction_payloads",
    "_classify_monthly_rows",
    "_load_transaction_raw_rows",
    "_normalize_pt3_payload",
    "_parse_transaction_datetime",
    "_pt3_float",
]

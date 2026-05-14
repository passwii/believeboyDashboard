"""Payment report row classifier.

Classifies payment report rows into business categories
(e.g. Order/Refund/Service Fee/Advertising/FBA Inventory Fee, etc.).
"""
from __future__ import annotations

from typing import Any


def classify_rows(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """Classify payment report rows into business categories.

    Args:
        rows: List of payment report rows as dicts (from read_payment_csv output).

    Returns:
        Dict with category keys like 'order', 'refund', 'service_fee',
        'advertising', 'amazon_fees', 'fba_inventory_fee', etc.
    """
    classified: dict[str, list[dict[str, Any]]] = {
        "order": [],
        "refund": [],
        "blank_type": [],
        "fba_customer_return_fee": [],
        "amazon_fees_reversal": [],
        "chargeback_refund": [],
        "liquidation": [],
        "adjustment": [],
        "service_fee": [],
        "fba_inventory_fee": [],
        "amazon_fees": [],
        "fee_adjustment": [],
        "deal_fee": [],
        "debt": [],
        "fba_transaction_fees": [],
        "fba_order": [],
        "fbm_order": [],
        "fba_refund": [],
        "fbm_refund": [],
        "adjustment_income": [],
        "adjustment_expense": [],
        "advertising": [],
        "agl_selection": [],
        "service_refund_for_advertiser": [],
        "amazon_fees_and_service_fee_without_ad": [],
        "price_discount": [],
        "fee_adjustment_weight_dim": [],
    }

    adjustment_expense_descriptions = {
        "FBA Inventory Reimbursement - General Adjustment",
        "Non-subscription Fee Adjustment",
    }
    ad_excluded_descriptions = {
        "Cost of Advertising",
        "Refund for Advertiser",
    }
    agl_descriptions = {
        "FBA International Freight Shipping Charge",
        "FBA International Freight Duties and Taxes Charge",
    }
    fee_adjustment_target = "Fee Adjustment - Weight and Dimension Change"

    for row in rows:
        row_type = str(row.get("type", "")).strip()
        description = str(row.get("description", "")).strip()
        fulfillment = str(row.get("fulfillment", "")).strip()

        if not row_type:
            classified["blank_type"].append(row)
            if description.startswith("Price Discount"):
                classified["price_discount"].append(row)
            continue

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

        if row_type == "FBA Customer Return Fee":
            classified["fba_customer_return_fee"].append(row)
            continue
        if row_type == "Amazon Fees - Reversal":
            classified["amazon_fees_reversal"].append(row)
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
        if row_type == "Amazon Fees":
            classified["amazon_fees"].append(row)
            if description not in ad_excluded_descriptions:
                classified["amazon_fees_and_service_fee_without_ad"].append(row)
            continue
        if row_type == "Deal Fee":
            classified["deal_fee"].append(row)
            continue
        if row_type == "Debt":
            classified["debt"].append(row)
            continue
        if row_type == "FBA Transaction fees":
            classified["fba_transaction_fees"].append(row)
            continue
        if row_type == "Fee Adjustment":
            classified["fee_adjustment"].append(row)
            if description == fee_adjustment_target:
                classified["fee_adjustment_weight_dim"].append(row)
            continue
        if row_type == "Adjustment":
            classified["adjustment"].append(row)
            if description in adjustment_expense_descriptions:
                classified["adjustment_expense"].append(row)
            else:
                classified["adjustment_income"].append(row)
            continue
        if row_type == "Service Fee":
            classified["service_fee"].append(row)
            if description not in ad_excluded_descriptions:
                classified["amazon_fees_and_service_fee_without_ad"].append(row)
            if description == "Cost of Advertising":
                classified["advertising"].append(row)
            elif description == "Refund for Advertiser":
                classified["service_refund_for_advertiser"].append(row)
            elif description in agl_descriptions:
                classified["agl_selection"].append(row)

    return classified

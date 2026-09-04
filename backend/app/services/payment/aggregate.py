"""Payment report SKU-level aggregator.

Aggregates payment report rows by SKU for product analysis consumption.
"""
from __future__ import annotations

import pandas as pd


def build_sku_aggregate(df_payment: pd.DataFrame) -> pd.DataFrame:
    """Aggregate payment report rows by SKU.

    Groups Order and Refund rows by SKU, computing sales volume, sales amount,
    refund volume, refund amount, selling fees, and FBA fees.

    Args:
        df_payment: Payment report DataFrame (from read_payment_csv).

    Returns:
        DataFrame with columns: SKU, 实际销售量, 实际销售额,
        实际退款量, 实际退款额, 平台佣金, FBA配送费
    """
    df_order_and_refund = df_payment.loc[df_payment["type"].isin(["Order", "Refund"])]
    df_orders = df_payment.loc[df_payment["type"] == "Order"]
    df_refunds = df_payment.loc[df_payment["type"] == "Refund"]

    sale_refund_amz_fee = df_order_and_refund.groupby("sku", as_index=False).agg(
        {
            "selling fees": lambda x: round(x.mul(-1).sum(), 2),
            "fba fees": lambda x: round(x.mul(-1).sum(), 2),
        }
    )

    sale_group = df_orders.groupby("sku", as_index=False).agg(
        {
            "quantity": "sum",
            "product sales": lambda x: round(x.sum(), 2),
            "shipping credits": lambda x: round(x.sum(), 2),
            "promotional rebates": lambda x: round(x.sum(), 2),
        }
    )
    sale_group["sale total"] = (
        sale_group["product sales"]
        + sale_group["shipping credits"]
        + sale_group["promotional rebates"]
    )
    sale_group = sale_group.rename(
        columns={"quantity": "实际销售量", "sale total": "实际销售额"}
    )
    sale_group = sale_group.drop(
        columns=["product sales", "shipping credits", "promotional rebates"]
    )

    refund_group = df_refunds.groupby("sku", as_index=False).agg(
        {
            "quantity": lambda x: abs(x.sum()),
            "product sales": lambda x: round(x.sum(), 2),
            "shipping credits": lambda x: round(x.sum(), 2),
            "promotional rebates": lambda x: round(x.sum(), 2),
            "other": lambda x: round(x.sum(), 2),
        }
    )
    refund_group["refund total"] = abs(
        refund_group["product sales"]
        + refund_group["shipping credits"]
        + refund_group["promotional rebates"]
        + refund_group["other"]
    )
    refund_group = refund_group.rename(
        columns={
            "quantity": "实际退款量",
            "refund total": "实际退款额",
        }
    )
    refund_group = refund_group.drop(
        columns=["product sales", "shipping credits", "promotional rebates", "other"]
    )

    merged = pd.merge(sale_group, refund_group, on="sku", how="left")
    merged = pd.merge(merged, sale_refund_amz_fee, on="sku", how="left")
    merged.rename(
        columns={
            "sku": "SKU",
            "selling fees": "平台佣金",
            "fba fees": "FBA配送费",
        },
        inplace=True,
    )
    return merged

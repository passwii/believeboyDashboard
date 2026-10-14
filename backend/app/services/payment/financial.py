"""Payment report financial metrics computation.

Extracts full P&L metric calculation from the monthly report task script.
Handles income/expense line items, pt3/pt4 payload generation.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from app.utils.sales_amount import VAT_INCLUSIVE_COUNTRIES

TWO_DP = Decimal("0.01")
FOUR_DP = Decimal("0.0001")


def _to_decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    text = str(value).strip().replace(",", "")
    if not text:
        return Decimal("0")
    try:
        return Decimal(text)
    except InvalidOperation:
        return Decimal("0")


def _round2(value: Decimal) -> Decimal:
    return value.quantize(TWO_DP, rounding=ROUND_HALF_UP)


def _sum_field(rows: list[dict[str, object]], field: str) -> Decimal:
    return _round2(sum((_to_decimal(row.get(field)) for row in rows), Decimal("0")))


def _safe_div_percent_decimal(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator == 0:
        return Decimal("0")
    return (
        ((abs(numerator) / denominator) * Decimal("100")).quantize(
            FOUR_DP, rounding=ROUND_HALF_UP
        )
    )


def _compute_vat_metrics(
    classified: dict[str, list[dict[str, object]]],
    country: str,
) -> dict[str, Decimal]:
    """Compute VAT (sales tax) metrics for tax-inclusive countries (DE/UK).

    For non-VAT countries (e.g. US), ``income_sales_with_tax`` is the *net*
    sales (i.e. ``sum(product_sales)``), so that downstream consumers can
    always pick this field as the displayed sales amount — no special
    branching by country needed.

    VAT 聚合口径：以 ``marketplace withheld tax`` 列（DE 对应
    ``Einbehaltene Steuer auf Marketplace``，US/UK/DE 都经
    ``payment_locale.PAYMENT_REPORT_COLUMN_ALIASES`` 归一化为同一 canonical
    key）累加 Order+Refund 行。**直接存储该列的聚合值**（Amazon 报表中此列
    与 ``product sales tax`` 符号相反：向买家收的 VAT 记正、Amazon 代扣代缴给
    税局记负），不再取负。故 ``income_vat_total`` 对订单为负、对退款为正，
    与 Amazon 原始语义一致，也和下游 PT3/PT4/前端展示对齐。

    Args:
        classified: Dict of classified rows from classify_rows().
        country: Normalized country code (US/DE/UK).

    Returns:
        Dict with keys:
        - income_vat_total: ``Σmarketplace_withheld_tax`` over Order+Refund rows
          （订单为负；绝对值与 ``Σproduct_sales_tax`` 相同，符号相反）
        - income_sales_with_tax: DE/UK = ``Σproduct_sales - income_vat_total``
          （= ``Σproduct_sales - Σmarketplace_withheld_tax``，数值等于
          ``Σproduct_sales + Σproduct_sales_tax`` 的 gross 价）；
          US = ``Σproduct_sales``（net）
        - expense_vat_total: 镜像 income_vat_total（供 PT4 回款公式使用）
    """
    # 跨所有 Order/Refund 行计算。注意 fba_refund / fbm_refund 的 product_sales 是负数
    # （退款为负），所以 sales_with_tax 也自然为负（消费者退的钱含税）。
    # 单元测试可能只塞入部分 key，``get`` 兜底保证向后兼容。
    all_sales_rows = classified.get("order", []) + classified.get("refund", [])
    net_sales = _round2(
        sum((_to_decimal(row.get("product sales")) for row in all_sales_rows), Decimal("0"))
    )

    normalized = (country or "").strip().upper()
    if normalized not in VAT_INCLUSIVE_COUNTRIES:
        # US 等无 VAT 国家：sales_with_tax 退化为净额，VAT 列保持 0
        return {
            "income_vat_total": Decimal("0"),
            "income_sales_with_tax": net_sales,
            "expense_vat_total": Decimal("0"),
        }

    # DE/UK：以 ``marketplace withheld tax`` 列聚合，**直接存储原始符号**
    # （Amazon 报表中此列与 ``product sales tax`` 符号相反，订单为负）。
    # 下游用 ``net_sales - income_vat_total`` 还原 gross，数值与旧口径一致。
    withheld_total = _round2(
        sum((_to_decimal(row.get("marketplace withheld tax")) for row in all_sales_rows), Decimal("0"))
    )
    income_vat_total = withheld_total
    # gross = Σproduct_sales + Σproduct_sales_tax
    #      = Σproduct_sales - Σmarketplace_withheld_tax
    #      = net_sales - income_vat_total（income_vat_total 为负时退化为加）
    income_sales_with_tax = _round2(net_sales - income_vat_total)
    return {
        "income_vat_total": income_vat_total,
        "income_sales_with_tax": income_sales_with_tax,
        "expense_vat_total": income_vat_total,
    }


def compute_metrics(
    classified: dict[str, list[dict[str, object]]],
    country: str = "US",
) -> dict[str, Any]:
    """Compute full financial metrics from classified payment rows.

    Args:
        classified: Dict of classified rows from classify_rows().

    Returns:
        Dict with 'pt3' and 'pt4' payloads containing all computed metrics.
    """
    order = classified["order"]
    refund = classified["refund"]
    fba_customer_return_fee = classified["fba_customer_return_fee"]
    chargeback_refund = classified["chargeback_refund"]
    liquidation = classified["liquidation"]
    fba_inventory_fee = classified["fba_inventory_fee"]
    # Rows under type "FBA Transaction Fees" whose description is a
    # storage / inbound fee (e.g. "FBA Inventory Storage Fee"). They are
    # excluded from ``fba_transaction_fees`` by the classifier so they are
    # only ever counted once, in the inventory/inbound bucket below.
    fba_inventory_and_inbound_fees = classified.get(
        "fba_inventory_and_inbound_fees", []
    )
    fba_transaction_fees = classified["fba_transaction_fees"]

    fba_order = classified["fba_order"]
    fbm_order = classified["fbm_order"]
    fba_refund = classified["fba_refund"]
    fbm_refund = classified["fbm_refund"]
    adjustment_income = classified["adjustment_income"]
    adjustment_expense = classified["adjustment_expense"]
    advertising = classified["advertising"]
    agl_selection = classified["agl_selection"]
    service_refund_for_advertiser = classified["service_refund_for_advertiser"]
    amazon_fees_and_service_fee_without_ad = classified[
        "amazon_fees_and_service_fee_without_ad"
    ]

    fee_adjustment_fee = _sum_field(classified["fee_adjustment_weight_dim"], "total")

    product_sales_non_fba = _sum_field(fbm_order, "product sales")
    product_sale_refunds_non_fba = _sum_field(fbm_refund, "product sales")
    fba_product_sales = _sum_field(fba_order, "product sales")
    fba_product_sale_refunds = _round2(
        _sum_field(fba_refund, "product sales")
        + _sum_field(fba_refund, "other")
    )
    fba_inventory_credit = _sum_field(adjustment_income, "total")
    fba_liquidation_proceeds = _sum_field(liquidation, "product sales")
    shipping_credits = _sum_field(order, "shipping credits")
    shipping_credit_refunds = _sum_field(refund, "shipping credits")
    gift_wrap_credits = _sum_field(order, "gift wrap credits")
    gift_wrap_credits_refunds = _sum_field(refund, "gift wrap credits")
    promotional_rebates = _sum_field(order, "promotional rebates")
    promotional_rebate_refunds = _sum_field(refund, "promotional rebates")
    a_to_z_guarantee_claims = Decimal("0")
    chargebacks = _sum_field(chargeback_refund, "total")
    safe_t_reimbursement = Decimal("0")

    income_total = _round2(
        product_sales_non_fba
        + product_sale_refunds_non_fba
        + fba_product_sales
        + fba_product_sale_refunds
        + fba_inventory_credit
        + fba_liquidation_proceeds
        + shipping_credits
        + shipping_credit_refunds
        + gift_wrap_credits
        + gift_wrap_credits_refunds
        + promotional_rebates
        + promotional_rebate_refunds
        + chargebacks
    )

    # ── VAT 适配（DE/UK tax-inclusive 口径）──
    vat_metrics = _compute_vat_metrics(classified, country)
    income_vat_total = vat_metrics["income_vat_total"]
    income_sales_with_tax = vat_metrics["income_sales_with_tax"]
    expense_vat_total = vat_metrics["expense_vat_total"]
    if income_vat_total != Decimal("0"):
        # VAT 存储为负数（代扣代缴），income_total = net - income_vat_total
        # = net + |VAT|，与旧口径 gross 一致。
        income_total = _round2(income_total - income_vat_total)

    seller_fulfilled_selling_fees = _sum_field(fbm_order, "selling fees")
    fba_selling_fees = _sum_field(fba_order, "selling fees")
    selling_fee_refunds = _sum_field(refund, "selling fees")
    # FBA 派送费总额 = Amazon 履约 Order 行的 fba fees 列
    #   + 独立 "FBA Transaction Fees" 类型行中**非仓储/入库**部分的 fba fees 列。
    # 该桶同时涵盖别名 "Fulfilment by Amazon (FBA) transaction fees"
    # （见 app.utils.payment_locale.PAYMENT_TYPE_ALIASES），其 fba fees 经
    # 归一化后同样归入此桶，无需额外求和处理。
    # 仓储 / 入库行（"FBA Inventory Storage Fee"、"FBA Long Term Storage Fee"
    # 等）由 classifier 归入 ``fba_inventory_and_inbound_fees``，不在此处重复。
    fba_transaction_fees_total = _round2(
        _sum_field(fba_order, "fba fees")
        + _sum_field(fba_transaction_fees, "fba fees")
    )
    fba_transaction_fee_refunds = _round2(
        _sum_field(fba_refund, "fba fees") + fee_adjustment_fee
    )
    # Other transaction fees / refunds：对齐 Amazon 月报 PDF 口径，
    # 取 Order / Refund 行 CSV 的 "other transaction fees" 列求和。
    # 注意：Service Fee(Cost of Advertising) 已计入 advertising，
    # Liquidations 的 otf 已计入 liquidations_fees，此处均不重复计入。
    other_transaction_fees = _sum_field(order, "other transaction fees")
    other_transaction_fee_refunds = _sum_field(refund, "other transaction fees")
    # FBA 库存和入库服务费 = "FBA Inventory Fee" 类型行
    #   + "FBA Transaction Fees" 类型行里描述为仓储/入库的部分的 total
    #   + FBA 退货处理费 + AGL 头程相关费用。
    fba_inventory_and_inbound_services_fees = _round2(
        _sum_field(fba_inventory_fee, "total")
        + _sum_field(fba_inventory_and_inbound_fees, "total")
        + _sum_field(fba_customer_return_fee, "total")
        + _sum_field(agl_selection, "total")
    )
    shipping_label_purchases = Decimal("0")
    shipping_label_refunds = Decimal("0")
    carrier_shipping_label_adjustments = Decimal("0")

    service_fees_total = _round2(
        _sum_field(amazon_fees_and_service_fee_without_ad, "total")
    )

    refund_administration_fees = Decimal("0")
    adjustments = _sum_field(adjustment_expense, "total")
    cost_of_advertising = _sum_field(advertising, "total")
    refund_for_advertiser = _sum_field(service_refund_for_advertiser, "total")
    liquidations_fees = _sum_field(liquidation, "other transaction fees")
    receivables = Decimal("0")
    deductions = Decimal("0")
    amazon_shipping_charge_adjustments = Decimal("0")

    expense_total = _round2(
        seller_fulfilled_selling_fees
        + fba_selling_fees
        + selling_fee_refunds
        + fba_transaction_fees_total
        + fba_transaction_fee_refunds
        + other_transaction_fees
        + other_transaction_fee_refunds
        + fba_inventory_and_inbound_services_fees
        + shipping_label_purchases
        + shipping_label_refunds
        + carrier_shipping_label_adjustments
        + service_fees_total
        + refund_administration_fees
        + adjustments
        + cost_of_advertising
        + refund_for_advertiser
        + liquidations_fees
        + receivables
        + deductions
        + amazon_shipping_charge_adjustments
    )

    pt3_payload = {
        "income_product_sales_non_fba": product_sales_non_fba,
        "income_product_sale_refunds_non_fba": product_sale_refunds_non_fba,
        "income_fba_product_sales": fba_product_sales,
        "income_fba_product_sale_refunds": fba_product_sale_refunds,
        "income_fba_inventory_credit": fba_inventory_credit,
        "income_fba_liquidation_proceeds": fba_liquidation_proceeds,
        "income_shipping_credits": shipping_credits,
        "income_shipping_credit_refunds": shipping_credit_refunds,
        "income_gift_wrap_credits": gift_wrap_credits,
        "income_gift_wrap_credits_refunds": gift_wrap_credits_refunds,
        "income_promotional_rebates": promotional_rebates,
        "income_promotional_rebate_refunds": promotional_rebate_refunds,
        "income_a_to_z_guarantee_claims": a_to_z_guarantee_claims,
        "income_chargebacks": chargebacks,
        "income_safe_t_reimbursement": safe_t_reimbursement,
        "income_total": income_total,
        "income_vat_total": income_vat_total,
        "income_sales_with_tax": income_sales_with_tax,
        "expense_seller_fulfilled_selling_fees": seller_fulfilled_selling_fees,
        "expense_fba_selling_fees": fba_selling_fees,
        "expense_selling_fee_refunds": selling_fee_refunds,
        "expense_fba_transaction_fees": fba_transaction_fees_total,
        "expense_fba_transaction_fee_refunds": fba_transaction_fee_refunds,
        "expense_other_transaction_fees": other_transaction_fees,
        "expense_other_transaction_fee_refunds": other_transaction_fee_refunds,
        "expense_fba_inventory_and_inbound_services_fees": fba_inventory_and_inbound_services_fees,
        "expense_shipping_label_purchases": shipping_label_purchases,
        "expense_shipping_label_refunds": shipping_label_refunds,
        "expense_carrier_shipping_label_adjustments": carrier_shipping_label_adjustments,
        "expense_service_fees": service_fees_total,
        "expense_refund_administration_fees": refund_administration_fees,
        "expense_adjustments": adjustments,
        "expense_cost_of_advertising": cost_of_advertising,
        "expense_refund_for_advertiser": refund_for_advertiser,
        "expense_liquidations_fees": liquidations_fees,
        "expense_receivables": receivables,
        "expense_deductions": deductions,
        "expense_amazon_shipping_charge_adjustments": amazon_shipping_charge_adjustments,
        "expense_total": expense_total,
        "advertising_percentage": _safe_div_percent_decimal(
            cost_of_advertising, income_total
        ),
    }

    # PT4 收入-销售额 = PT3 销售额明细（FBA/非FBA 产品销售额 + 运费 + 礼品包装
    # + 促销返点）拆分合计；UK/DE 额外叠加 VAT 做 gross 化。
    # income_vat_total = Σ marketplace withheld tax（见 _compute_vat_metrics，
    # 订单为负），故用减法还原 gross：net - income_vat_total = net + |VAT|；
    # US 该值为 0，减 0 无影响。
    pt4_income_sales = _round2(
        product_sales_non_fba
        + fba_product_sales
        + shipping_credits
        + gift_wrap_credits
        + promotional_rebates
        - income_vat_total
    )
    pt4_income_refund = _round2(
        product_sale_refunds_non_fba
        + fba_product_sale_refunds
        + shipping_credit_refunds
        + gift_wrap_credits_refunds
        + promotional_rebate_refunds
    )
    pt4_income_adjustment = _round2(
        fba_inventory_credit + fba_liquidation_proceeds
    )
    pt4_income_chargeback = _round2(
        chargebacks + a_to_z_guarantee_claims + safe_t_reimbursement
    )
    pt4_income_total = _round2(
        pt4_income_sales
        + pt4_income_refund
        + pt4_income_adjustment
        + pt4_income_chargeback
    )

    pt4_expense_selling_fee = _round2(
        seller_fulfilled_selling_fees + fba_selling_fees + selling_fee_refunds
    )
    pt4_expense_fba_fee = _round2(
        fba_transaction_fees_total + fba_transaction_fee_refunds
    )
    pt4_expense_inventory_fee = fba_inventory_and_inbound_services_fees
    pt4_service_fee = service_fees_total
    pt4_expense_advertising = _round2(
        cost_of_advertising + refund_for_advertiser
    )
    pt4_expense_other_fees = _round2(
        adjustments
        + liquidations_fees
        + other_transaction_fees
        + other_transaction_fee_refunds
        + receivables
        + deductions
        + amazon_shipping_charge_adjustments
        + shipping_label_purchases
        + shipping_label_refunds
        + carrier_shipping_label_adjustments
    )
    pt4_expense_total = _round2(
        pt4_expense_selling_fee
        + pt4_expense_fba_fee
        + pt4_expense_inventory_fee
        + pt4_service_fee
        + pt4_expense_advertising
        + pt4_expense_other_fees
    )

    # DE/UK 回款公式：收入 + 支出 + VAT（VAT 为负数，加负数等价于减 |VAT|）
    # US：expense_vat_total = 0 → 与原公式完全一致
    amazon_pay_back = _round2(
        pt4_income_total + pt4_expense_total + expense_vat_total
    )

    pt4_payload = {
        "income_sales": pt4_income_sales,
        "income_refund": pt4_income_refund,
        "income_adjustment": pt4_income_adjustment,
        "income_other": pt4_income_chargeback,
        "income_total": pt4_income_total,
        "expense_selling_fee": pt4_expense_selling_fee,
        "expense_fba_fee": pt4_expense_fba_fee,
        "expense_inventory_fee": pt4_expense_inventory_fee,
        "expense_service_fee": pt4_service_fee,
        "expense_advertising": pt4_expense_advertising,
        "expense_other_fees": pt4_expense_other_fees,
        "expense_total": pt4_expense_total,
        "expense_vat_total": expense_vat_total,
        "amazon_pay_back": amazon_pay_back,
    }

    return {"pt3": pt3_payload, "pt4": pt4_payload}

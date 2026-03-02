from __future__ import annotations

import csv
from collections import defaultdict
from collections.abc import Callable
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, NamedStyle, Side
from openpyxl.utils import get_column_letter

TWO_DP = Decimal("0.01")
FOUR_DP = Decimal("0.0001")
ProgressCallback = Callable[[str, int, str], None]


def _safe_project_name(project_name: str) -> str:
    sanitized = "".join(ch for ch in project_name.strip() if ch not in r'\\/:*?"<>|')
    return sanitized or "unknown"


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


def _safe_div_percent(numerator: Decimal, denominator: Decimal) -> str:
    if denominator == 0:
        return "0.00%"
    ratio = (abs(numerator) / denominator) * Decimal("100")
    return f"{_round2(ratio)}%"


def _num(value: Decimal) -> float:
    return float(_round2(value))


def _safe_div_percent_decimal(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator == 0:
        return Decimal("0")
    return ((abs(numerator) / denominator) * Decimal("100")).quantize(FOUR_DP, rounding=ROUND_HALF_UP)


def _read_transactions(input_path: str) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    with open(input_path, "r", encoding="utf-8-sig", newline="") as fh:
        for _ in range(7):
            next(fh, None)
        reader = csv.DictReader(fh)
        for row in reader:
            normalized = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
            normalized["quantity"] = int(_to_decimal(normalized.get("quantity") or 0))
            rows.append(normalized)
    return rows


def _classify_rows(all_rows: list[dict[str, object]]) -> dict[str, list[dict[str, object]]]:
    classified: dict[str, list[dict[str, object]]] = {
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

    for row in all_rows:
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


def _group_sku_quantity(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    grouped: dict[str, int] = defaultdict(int)
    for row in rows:
        sku = str(row.get("sku", "") or "")
        if not sku:
            continue
        grouped[sku] += int(_to_decimal(row.get("quantity") or 0))
    data = [{"sku": sku, "quantity": qty} for sku, qty in grouped.items()]
    data.sort(key=lambda item: item["quantity"], reverse=True)
    return data


def _rows_to_sheet(ws, rows: list[dict[str, object]]) -> None:
    if not rows:
        ws.append(["No Data"])
        return

    headers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row.keys():
            if key not in seen:
                seen.add(key)
                headers.append(key)

    ws.append(headers)
    for row in rows:
        ws.append([row.get(h, "") for h in headers])


def _auto_width_for_report_sheet(ws) -> None:
    for col in range(1, ws.max_column + 1):
        letter = get_column_letter(col)
        max_length = 0
        for row in range(1, ws.max_row + 1):
            value = ws.cell(row, col).value
            if value is None:
                continue
            text = str(value)
            length = 0
            for ch in text:
                length += 2 if "\u4e00" <= ch <= "\u9fff" else 1
            max_length = max(max_length, length)
        ws.column_dimensions[letter].width = min(max(max_length + 2, 8), 50)


def _apply_styles(workbook: Workbook) -> None:
    thin = Side(style="thin", color="000000")

    if "sty1" not in workbook.named_styles:
        sty1 = NamedStyle(name="sty1")
        sty1.font = Font(name="等线", size=12, bold=True)
        sty1.alignment = Alignment(horizontal="left", vertical="center")
        sty1.border = Border(top=thin, bottom=thin, left=thin, right=thin)
        workbook.add_named_style(sty1)

    if "sty2" not in workbook.named_styles:
        sty2 = NamedStyle(name="sty2")
        sty2.font = Font(name="等线", size=12)
        sty2.alignment = Alignment(horizontal="left", vertical="center")
        sty2.border = Border(top=thin, bottom=thin, left=thin, right=thin)
        workbook.add_named_style(sty2)

    core_sheets = {"总览草稿", "报表核算"}
    for ws in workbook.worksheets:
        ws.freeze_panes = "A2"
        if ws.title in core_sheets:
            for r in range(1, ws.max_row + 1):
                for c in range(1, ws.max_column + 1):
                    ws.cell(r, c).style = "sty1" if r == 1 else "sty2"
                if r == 1:
                    ws.row_dimensions[r].height = 15

        else:
            for c in range(1, ws.max_column + 1):
                ws.cell(1, c).style = "sty1"
            ws.row_dimensions[1].height = 15

        if ws.title == "报表核算":
            _auto_width_for_report_sheet(ws)
        else:
            for c in range(1, ws.max_column + 1):
                ws.column_dimensions[get_column_letter(c)].width = 12


def run(input_path: str, output_dir: str, params: dict) -> dict:
    callback: ProgressCallback | None = params.get("_progress_callback")

    def report(stage: str, progress: int, message: str) -> None:
        if not callable(callback):
            return
        try:
            callback(stage, progress, message)
        except Exception:
            # Progress reporting should never break core report generation.
            return

    output_root = Path(output_dir)
    output_root.mkdir(parents=True, exist_ok=True)

    project_name = _safe_project_name(str(params.get("project_name", "unknown")))
    report_month = str(params.get("report_month", datetime.utcnow().strftime("%Y-%m")))

    report("reading_transactions", 15, "处理中：正在读取交易数据")
    all_rows = _read_transactions(input_path)
    report("classifying_transactions", 28, "处理中：正在分类交易数据")
    c = _classify_rows(all_rows)

    order = c["order"]
    refund = c["refund"]
    fba_customer_return_fee = c["fba_customer_return_fee"]
    amazon_fees_reversal = c["amazon_fees_reversal"]
    chargeback_refund = c["chargeback_refund"]
    liquidation = c["liquidation"]
    service_fee = c["service_fee"]
    fba_inventory_fee = c["fba_inventory_fee"]
    amazon_fees = c["amazon_fees"]
    fee_adjustment = c["fee_adjustment"]
    deal_fee = c["deal_fee"]
    debt = c["debt"]
    fba_transaction_fees = c["fba_transaction_fees"]

    fba_order = c["fba_order"]
    fbm_order = c["fbm_order"]
    fba_refund = c["fba_refund"]
    fbm_refund = c["fbm_refund"]
    adjustment_income = c["adjustment_income"]
    adjustment_expense = c["adjustment_expense"]
    advertising = c["advertising"]
    agl_selection = c["agl_selection"]
    service_refund_for_advertiser = c["service_refund_for_advertiser"]
    price_discount = c["price_discount"]
    amazon_fees_and_service_fee_without_ad = c["amazon_fees_and_service_fee_without_ad"]

    fee_adjustment_fee = _sum_field(c["fee_adjustment_weight_dim"], "total")

    product_sales_non_fba = _sum_field(fbm_order, "product sales")
    product_sale_refunds_non_fba = _sum_field(fbm_refund, "product sales")
    fba_product_sales = _sum_field(fba_order, "product sales")
    fba_product_sale_refunds = _round2(_sum_field(fba_refund, "product sales") + _sum_field(fba_refund, "other"))
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

    seller_fulfilled_selling_fees = _sum_field(fbm_order, "selling fees")
    fba_selling_fees = _sum_field(fba_order, "selling fees")
    selling_fee_refunds = _sum_field(refund, "selling fees")
    fba_transaction_fees_total = _round2(_sum_field(fba_order, "fba fees") + _sum_field(fba_transaction_fees, "fba fees"))
    fba_transaction_fee_refunds = _round2(_sum_field(fba_refund, "fba fees") + fee_adjustment_fee)
    other_transaction_fees = Decimal("0")
    other_transaction_fee_refunds = Decimal("0")
    fba_inventory_and_inbound_services_fees = _round2(
        _sum_field(fba_inventory_fee, "total")
        + _sum_field(fba_customer_return_fee, "total")
        + _sum_field(agl_selection, "total")
    )
    shipping_label_purchases = Decimal("0")
    shipping_label_refunds = Decimal("0")
    carrier_shipping_label_adjustments = Decimal("0")

    coupon_performance_base_fee = _sum_field(amazon_fees_reversal, "total")
    coupon_fee = _sum_field(amazon_fees, "total")
    lightning_deal_fee = _sum_field(deal_fee, "total")
    service_price_discount = _sum_field(price_discount, "total")
    service_fees_without_ads = _sum_field(
        [
            row
            for row in service_fee
            if str(row.get("description", ""))
            not in {
                "Cost of Advertising",
                "Refund for Advertiser",
                "FBA International Freight Shipping Charge",
                "FBA International Freight Duties and Taxes Charge",
            }
        ],
        "total",
    )
    service_fees = _round2(
        coupon_fee
        + service_fees_without_ads
        + lightning_deal_fee
        + service_price_discount
        + coupon_performance_base_fee
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
        + service_fees
        + refund_administration_fees
        + adjustments
        + cost_of_advertising
        + refund_for_advertiser
        + liquidations_fees
        + receivables
        + deductions
        + amazon_shipping_charge_adjustments
    )

    pt4_income_sales = _round2(
        product_sales_non_fba + fba_product_sales + shipping_credits + gift_wrap_credits + promotional_rebates
    )
    pt4_income_refund = _round2(
        product_sale_refunds_non_fba
        + fba_product_sale_refunds
        + shipping_credit_refunds
        + gift_wrap_credits_refunds
        + promotional_rebate_refunds
    )
    pt4_income_adjustment = _round2(fba_inventory_credit + fba_liquidation_proceeds)
    pt4_income_chargeback = _round2(chargebacks + a_to_z_guarantee_claims + safe_t_reimbursement)
    pt4_income_total = _round2(pt4_income_sales + pt4_income_refund + pt4_income_adjustment + pt4_income_chargeback)

    pt4_expense_selling_fee = _round2(seller_fulfilled_selling_fees + fba_selling_fees + selling_fee_refunds)
    pt4_expense_fba_fee = _round2(fba_transaction_fees_total + fba_transaction_fee_refunds)
    pt4_expense_inventory_fee = fba_inventory_and_inbound_services_fees
    pt4_service_fee = service_fees
    pt4_expense_advertising = _round2(cost_of_advertising + refund_for_advertiser)
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

    amazon_pay_back = _round2(pt4_income_total + pt4_expense_total)
    amz_card = _sum_field(debt, "total")
    advertising_percentage = _safe_div_percent_decimal(cost_of_advertising, income_total)
    report("computing_summary", 42, "合成数据：已完成核心指标计算")

    wb = Workbook()

    report("building_overview", 58, "合成数据：正在生成报表总览")
    ws_overview = wb.active
    ws_overview.title = "总览草稿"
    ws_overview.append([
        "1-销售额",
        "2-销售额退款",
        "3-赔偿",
        "4-其他收入",
        "5-平台费",
        "6-派送费",
        "7-仓储费",
        "8-服务费",
        "9-广告费",
        "10-其他费用",
        "收入合计",
        "支出合计",
        "亚马逊回款金额",
        "信用卡扣款-支出",
        "推广费占比",
        "说明",
    ])
    ws_overview.append([
        _num(pt4_income_sales),
        _num(pt4_income_refund),
        _num(pt4_income_adjustment),
        _num(pt4_income_chargeback),
        _num(pt4_expense_selling_fee),
        _num(pt4_expense_fba_fee),
        _num(pt4_expense_inventory_fee),
        _num(pt4_service_fee),
        _num(pt4_expense_advertising),
        _num(pt4_expense_other_fees),
        _num(pt4_income_total),
        _num(pt4_expense_total),
        _num(amazon_pay_back),
        _num(amz_card),
        _safe_div_percent(cost_of_advertising, income_total),
        "PDF已暂不处理，仅按交易CSV核算",
    ])

    ws_accounting = wb.create_sheet(title="报表核算")
    report("building_accounting", 68, "合成数据：正在生成报表核算")
    ws_accounting.append([
        "Income",
        "收入",
        "In金额（USD）",
        "In源表",
        "",
        "Expense",
        "支出",
        "Ex金额（USD）",
        "Ex源表",
    ])
    income_lines = [
        ("Product sales (non-FBA)", "销售额（非FBA）", product_sales_non_fba, "FBM 订单-订单金额"),
        ("Product sale refunds (non-FBA) ", "销售额退款（非FBA）", product_sale_refunds_non_fba, "FBM 退款-订单金额"),
        ("FBA product sales", "销售额（FBA）", fba_product_sales, "FBA 订单-订单金额"),
        ("FBA product sale refunds", "销售额退款（FBA）", fba_product_sale_refunds, "FBA 退款-订单金额 + 其他金额"),
        ("FBA inventory credit", "FBA库存赔偿（FBA）", fba_inventory_credit, "FBA库存赔偿-总计"),
        ("FBA liquidation proceeds", "FBA清算收入", fba_liquidation_proceeds, "清算费用-订单金额"),
        ("Shipping credits", "运费收入", shipping_credits, "所有订单-运费金额"),
        ("Shipping credit refunds", "运费退款", shipping_credit_refunds, "所有退款-运费金额"),
        ("Gift wrap credits", "礼品包装收入", gift_wrap_credits, "所有订单-礼品包装金额"),
        ("Gift wrap credit refunds", "礼品包装退款", gift_wrap_credits_refunds, "所有退款-礼品包装金额"),
        ("Promotional rebates", "促销折扣", promotional_rebates, "所有订单-促销折扣金额"),
        ("Promotional rebate refunds", "促销折扣退款", promotional_rebate_refunds, "所有退款-促销折扣金额"),
        ("A-to-z Guarantee claims", "A-to-z保障索赔", a_to_z_guarantee_claims, ""),
        ("Chargebacks", "拒付退款", chargebacks, "拒付退款-总计"),
        ("SAFE-T reimbursement", "SAFE-T赔偿", safe_t_reimbursement, ""),
        ("", "", Decimal("0"), ""),
        ("", "", Decimal("0"), ""),
        ("", "", Decimal("0"), ""),
        ("", "", Decimal("0"), ""),
        ("", "", Decimal("0"), ""),
        ("", "", Decimal("0"), ""),
        ("Total_Income", "合计销售额", income_total, ""),
    ]
    expense_lines = [
        ("Seller fulfilled selling fees", "卖家自配送销售佣金", seller_fulfilled_selling_fees, "FBM 订单-销售佣金"),
        ("FBA selling fees", "FBA销售佣金", fba_selling_fees, "FBA 订单-销售佣金"),
        ("Selling fee refunds", "销售佣金退款", selling_fee_refunds, "所有退款-销售佣金 + 退款管理费"),
        ("FBA transaction fees", "FBA派送费", fba_transaction_fees_total, "FBA 订单 - 派送费"),
        ("FBA transaction fee refunds", "FBA派送费退款", fba_transaction_fee_refunds, "FBA 退款 - 派送费 + 测量费"),
        ("Other transaction fees", "其他交易费用", other_transaction_fees, ""),
        ("Other transaction fee refunds", "其他交易费用退款", other_transaction_fee_refunds, ""),
        ("FBA inventory and inbound services fees", "FBA库存和入库服务费", fba_inventory_and_inbound_services_fees, "FBA仓储及入库服务费 - 总计"),
        ("Shipping label purchases", "购买配送标签", shipping_label_purchases, ""),
        ("Shipping label refunds", "配送标签退款", shipping_label_refunds, ""),
        ("Carrier shipping label adjustments", "承运商配送标签调整", carrier_shipping_label_adjustments, ""),
        ("Service fees", "服务费", service_fees, "服务费（不含广告）-总计"),
        ("Refund administration fees", "退款管理费", refund_administration_fees, "合并在销售佣金退款中扣除"),
        ("Adjustments", "调整项", adjustments, "其他赔偿调整-总计"),
        ("Cost of Advertising", "广告成本", cost_of_advertising, "广告费-总计"),
        ("Refund for Advertiser", "广告商退款", refund_for_advertiser, "广告退款-总计"),
        ("Liquidations fees", "清算处理费", liquidations_fees, "清算费用-其他交易费用"),
        ("Receivables", "应收账款", receivables, ""),
        ("Deductions", "扣款", deductions, ""),
        ("Amazon Shipping Charge Adjustments", "亚马逊配送运费调整", amazon_shipping_charge_adjustments, ""),
        ("", "", Decimal("0"), ""),
        ("Total_Expense", "合计费用", expense_total, ""),
    ]
    for index in range(len(income_lines)):
        in_en, in_zh, in_amount, in_src = income_lines[index]
        ex_en, ex_zh, ex_amount, ex_src = expense_lines[index]
        ws_accounting.append([
            in_en,
            in_zh,
            _num(in_amount) if in_en else "",
            in_src,
            "",
            ex_en,
            ex_zh,
            _num(ex_amount) if ex_en else "",
            ex_src,
        ])

    sheets_to_write: list[tuple[str, list[dict[str, object]]]] = [
        ("交易一览", all_rows),
        ("销售SKU明细", _group_sku_quantity(order)),
        ("退款SKU明细", _group_sku_quantity(refund)),
        ("所有订单", order),
        ("所有退款", refund),
        ("FBM 订单", fbm_order),
        ("FBM 退款", fbm_refund),
        ("FBA 订单", fba_order),
        ("FBA 退款", fba_refund),
        ("FBA库存赔偿", adjustment_income),
        ("其他赔偿", adjustment_expense),
        ("清算费用", liquidation),
        ("拒付退款", chargeback_refund),
        ("FBA仓储及入库服务费", fba_inventory_fee),
        ("服务费（不含广告）", amazon_fees_and_service_fee_without_ad),
        ("广告费", advertising),
        ("广告退款", service_refund_for_advertiser),
    ]
    report("writing_detail_sheets", 80, "合成数据：正在写入明细表")
    for sheet_name, rows in sheets_to_write:
        ws = wb.create_sheet(title=sheet_name)
        _rows_to_sheet(ws, rows)

    report("styling_workbook", 90, "处理中：正在处理表格样式")
    _apply_styles(wb)

    filename = f"{project_name}_Monthly_Report_{report_month}.xlsx"
    result_path = output_root / filename
    report("saving_workbook", 94, "处理中：正在保存报表文件")
    wb.save(result_path)

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
        "expense_service_fees": service_fees,
        "expense_refund_administration_fees": refund_administration_fees,
        "expense_adjustments": adjustments,
        "expense_cost_of_advertising": cost_of_advertising,
        "expense_refund_for_advertiser": refund_for_advertiser,
        "expense_liquidations_fees": liquidations_fees,
        "expense_receivables": receivables,
        "expense_deductions": deductions,
        "expense_amazon_shipping_charge_adjustments": amazon_shipping_charge_adjustments,
        "expense_total": expense_total,
        "amazon_pay_back": amazon_pay_back,
        "advertising_percentage": advertising_percentage,
    }
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
        "amazon_pay_back": amazon_pay_back,
        "credit_card_deduction_usd": amz_card,
    }

    return {
        "result_path": str(result_path.resolve()),
        "filename": filename,
        "message": "Monthly report generated from transaction CSV (monthly summary PDF ignored)",
        "transactions": all_rows,
        "pt3": pt3_payload,
        "pt4": pt4_payload,
    }

package tasks

import (
	"math/big"
	"strings"
)

func classifyMonthlyPaymentRows(rows []*monthlyPaymentRow) monthlyClassifiedRows {
	classified := monthlyClassifiedRows{
		"order":                                  {},
		"refund":                                 {},
		"blank_type":                             {},
		"fba_customer_return_fee":                {},
		"amazon_fees_reversal":                   {},
		"chargeback_refund":                      {},
		"liquidation":                            {},
		"adjustment":                             {},
		"service_fee":                            {},
		"fba_inventory_fee":                      {},
		"amazon_fees":                            {},
		"fee_adjustment":                         {},
		"deal_fee":                               {},
		"debt":                                   {},
		"fba_transaction_fees":                   {},
		"fba_inventory_and_inbound_fees":         {},
		"fba_order":                              {},
		"fbm_order":                              {},
		"fba_refund":                             {},
		"fbm_refund":                             {},
		"adjustment_income":                      {},
		"adjustment_expense":                     {},
		"advertising":                            {},
		"agl_selection":                          {},
		"service_refund_for_advertiser":          {},
		"amazon_fees_and_service_fee_without_ad": {},
		"price_discount":                         {},
		"fee_adjustment_weight_dim":              {},
	}
	adjustmentExpenseDescriptions := map[string]bool{
		"FBA Inventory Reimbursement - General Adjustment": true,
		"Non-subscription Fee Adjustment":                  true,
		"Other":                                            true,
		"Buyer Recharge":                                   true,
	}
	adExcludedDescriptions := map[string]bool{
		"Cost of Advertising":   true,
		"Refund for Advertiser": true,
	}
	aglDescriptions := map[string]bool{
		"FBA International Freight Shipping Charge":         true,
		"FBA International Freight Duties and Taxes Charge": true,
	}
	const feeAdjustmentTarget = "Fee Adjustment - Weight and Dimension Change"

	for _, row := range rows {
		rowType := normalizeMonthlyPaymentType(row.fields["type"])
		description := normalizeMonthlyPaymentDescription(row.fields["description"], "")
		fulfillment := strings.TrimSpace(row.fields["fulfillment"])

		if rowType == "" {
			classified["blank_type"] = append(classified["blank_type"], row)
			if strings.HasPrefix(description, "Price Discount") {
				classified["price_discount"] = append(classified["price_discount"], row)
			}
			continue
		}
		switch rowType {
		case "Order":
			classified["order"] = append(classified["order"], row)
			if fulfillment == "Amazon" {
				classified["fba_order"] = append(classified["fba_order"], row)
			} else if fulfillment == "Seller" {
				classified["fbm_order"] = append(classified["fbm_order"], row)
			}
		case "Refund":
			classified["refund"] = append(classified["refund"], row)
			if fulfillment == "Amazon" {
				classified["fba_refund"] = append(classified["fba_refund"], row)
			} else if fulfillment == "Seller" {
				classified["fbm_refund"] = append(classified["fbm_refund"], row)
			}
		case "FBA Customer Return Fee":
			classified["fba_customer_return_fee"] = append(classified["fba_customer_return_fee"], row)
		case "Amazon Fees - Reversal":
			classified["amazon_fees_reversal"] = append(classified["amazon_fees_reversal"], row)
			if !adExcludedDescriptions[description] {
				classified["amazon_fees_and_service_fee_without_ad"] = append(
					classified["amazon_fees_and_service_fee_without_ad"],
					row,
				)
			}
		case "Amazon Fees - Correction", "Amazon Fees":
			classified["amazon_fees"] = append(classified["amazon_fees"], row)
			if !adExcludedDescriptions[description] {
				classified["amazon_fees_and_service_fee_without_ad"] = append(
					classified["amazon_fees_and_service_fee_without_ad"],
					row,
				)
			}
		case "Chargeback Refund":
			classified["chargeback_refund"] = append(classified["chargeback_refund"], row)
		case "Liquidations":
			classified["liquidation"] = append(classified["liquidation"], row)
		case "FBA Inventory Fee":
			classified["fba_inventory_fee"] = append(classified["fba_inventory_fee"], row)
		case "Deal Fee":
			classified["deal_fee"] = append(classified["deal_fee"], row)
		case "Debt":
			classified["debt"] = append(classified["debt"], row)
		case "FBA Transaction Fees":
			if isMonthlyFBAStorageFee(description) {
				classified["fba_inventory_and_inbound_fees"] = append(
					classified["fba_inventory_and_inbound_fees"],
					row,
				)
			} else {
				classified["fba_transaction_fees"] = append(
					classified["fba_transaction_fees"],
					row,
				)
			}
		case "Fee Adjustment":
			classified["fee_adjustment"] = append(classified["fee_adjustment"], row)
			if description == feeAdjustmentTarget {
				classified["fee_adjustment_weight_dim"] = append(
					classified["fee_adjustment_weight_dim"],
					row,
				)
			}
		case "Adjustment":
			classified["adjustment"] = append(classified["adjustment"], row)
			if adjustmentExpenseDescriptions[description] {
				classified["adjustment_expense"] = append(classified["adjustment_expense"], row)
			} else {
				classified["adjustment_income"] = append(classified["adjustment_income"], row)
			}
		case "Service Fee":
			classified["service_fee"] = append(classified["service_fee"], row)
			if !adExcludedDescriptions[description] {
				classified["amazon_fees_and_service_fee_without_ad"] = append(
					classified["amazon_fees_and_service_fee_without_ad"],
					row,
				)
			}
			switch description {
			case "Cost of Advertising":
				classified["advertising"] = append(classified["advertising"], row)
			case "Refund for Advertiser":
				classified["service_refund_for_advertiser"] = append(
					classified["service_refund_for_advertiser"],
					row,
				)
			default:
				if aglDescriptions[description] {
					classified["agl_selection"] = append(classified["agl_selection"], row)
				}
			}
		}
	}
	return classified
}

func computeMonthlyFinancialMetrics(
	classified monthlyClassifiedRows,
	country string,
) (monthlyAmountMap, monthlyAmountMap) {
	order := classified["order"]
	refund := classified["refund"]
	fbaCustomerReturnFee := classified["fba_customer_return_fee"]
	chargebackRefund := classified["chargeback_refund"]
	liquidation := classified["liquidation"]
	fbaInventoryFee := classified["fba_inventory_fee"]
	fbaInventoryAndInboundFees := classified["fba_inventory_and_inbound_fees"]
	fbaTransactionFees := classified["fba_transaction_fees"]

	fbaOrder := classified["fba_order"]
	fbmOrder := classified["fbm_order"]
	fbaRefund := classified["fba_refund"]
	fbmRefund := classified["fbm_refund"]
	adjustmentIncome := classified["adjustment_income"]
	adjustmentExpense := classified["adjustment_expense"]
	advertising := classified["advertising"]
	aglSelection := classified["agl_selection"]
	serviceRefundForAdvertiser := classified["service_refund_for_advertiser"]
	amazonFeesAndServiceFeeWithoutAd := classified["amazon_fees_and_service_fee_without_ad"]

	feeAdjustmentFee := monthlySumField(classified["fee_adjustment_weight_dim"], "total")

	productSalesNonFBA := monthlySumField(fbmOrder, "product sales")
	productSaleRefundsNonFBA := monthlySumField(fbmRefund, "product sales")
	fbaProductSales := monthlySumField(fbaOrder, "product sales")
	fbaProductSaleRefunds := roundMonthlyAmount(new(big.Rat).Add(
		monthlySumField(fbaRefund, "product sales"),
		monthlySumField(fbaRefund, "other"),
	))
	fbaInventoryCredit := monthlySumField(adjustmentIncome, "total")
	fbaLiquidationProceeds := monthlySumField(liquidation, "product sales")
	shippingCredits := monthlySumField(order, "shipping credits")
	shippingCreditRefunds := monthlySumField(refund, "shipping credits")
	giftWrapCredits := monthlySumField(order, "gift wrap credits")
	giftWrapCreditsRefunds := monthlySumField(refund, "gift wrap credits")
	promotionalRebates := monthlySumField(order, "promotional rebates")
	promotionalRebateRefunds := monthlySumField(refund, "promotional rebates")
	chargebacks := monthlySumField(chargebackRefund, "total")

	incomeTotal := roundMonthlyAmount(monthlyAdd(
		productSalesNonFBA,
		productSaleRefundsNonFBA,
		fbaProductSales,
		fbaProductSaleRefunds,
		fbaInventoryCredit,
		fbaLiquidationProceeds,
		shippingCredits,
		shippingCreditRefunds,
		giftWrapCredits,
		giftWrapCreditsRefunds,
		promotionalRebates,
		promotionalRebateRefunds,
		chargebacks,
	))
	incomeVATTotal, incomeSalesWithTax, expenseVATTotal := monthlyVATMetrics(classified, country)
	if incomeVATTotal.Sign() != 0 {
		incomeTotal = roundMonthlyAmount(new(big.Rat).Sub(incomeTotal, incomeVATTotal))
	}

	sellerFulfilledSellingFees := monthlySumField(fbmOrder, "selling fees")
	fbaSellingFees := monthlySumField(fbaOrder, "selling fees")
	sellingFeeRefunds := monthlySumField(refund, "selling fees")
	fbaTransactionFeesTotal := roundMonthlyAmount(new(big.Rat).Add(
		monthlySumField(fbaOrder, "fba fees"),
		monthlySumField(fbaTransactionFees, "fba fees"),
	))
	fbaTransactionFeeRefunds := roundMonthlyAmount(new(big.Rat).Add(
		monthlySumField(fbaRefund, "fba fees"),
		feeAdjustmentFee,
	))
	otherTransactionFees := monthlySumField(order, "other transaction fees")
	otherTransactionFeeRefunds := monthlySumField(refund, "other transaction fees")
	fbaInventoryAndInboundServicesFees := roundMonthlyAmount(monthlyAdd(
		monthlySumField(fbaInventoryFee, "total"),
		monthlySumField(fbaInventoryAndInboundFees, "total"),
		monthlySumField(fbaCustomerReturnFee, "total"),
		monthlySumField(aglSelection, "total"),
	))
	serviceFees := roundMonthlyAmount(monthlySumField(amazonFeesAndServiceFeeWithoutAd, "total"))
	adjustments := monthlySumField(adjustmentExpense, "total")
	costOfAdvertising := monthlySumField(advertising, "total")
	refundForAdvertiser := monthlySumField(serviceRefundForAdvertiser, "total")
	liquidationsFees := monthlySumField(liquidation, "other transaction fees")

	expenseTotal := roundMonthlyAmount(monthlyAdd(
		sellerFulfilledSellingFees,
		fbaSellingFees,
		sellingFeeRefunds,
		fbaTransactionFeesTotal,
		fbaTransactionFeeRefunds,
		otherTransactionFees,
		otherTransactionFeeRefunds,
		fbaInventoryAndInboundServicesFees,
		new(big.Rat),
		new(big.Rat),
		new(big.Rat),
		serviceFees,
		new(big.Rat),
		adjustments,
		costOfAdvertising,
		refundForAdvertiser,
		liquidationsFees,
		new(big.Rat),
		new(big.Rat),
		new(big.Rat),
	))

	pt4IncomeSales := roundMonthlyAmount(monthlyAdd(
		productSalesNonFBA,
		fbaProductSales,
		shippingCredits,
		giftWrapCredits,
		promotionalRebates,
		new(big.Rat).Neg(incomeVATTotal),
	))
	pt4IncomeRefund := roundMonthlyAmount(monthlyAdd(
		productSaleRefundsNonFBA,
		fbaProductSaleRefunds,
		shippingCreditRefunds,
		giftWrapCreditsRefunds,
		promotionalRebateRefunds,
	))
	pt4IncomeAdjustment := roundMonthlyAmount(monthlyAdd(fbaInventoryCredit, fbaLiquidationProceeds))
	pt4IncomeOther := roundMonthlyAmount(chargebacks)
	pt4IncomeTotal := roundMonthlyAmount(monthlyAdd(
		pt4IncomeSales,
		pt4IncomeRefund,
		pt4IncomeAdjustment,
		pt4IncomeOther,
	))
	pt4ExpenseSellingFee := roundMonthlyAmount(monthlyAdd(
		sellerFulfilledSellingFees,
		fbaSellingFees,
		sellingFeeRefunds,
	))
	pt4ExpenseFBAFee := roundMonthlyAmount(monthlyAdd(
		fbaTransactionFeesTotal,
		fbaTransactionFeeRefunds,
	))
	pt4ExpenseInventoryFee := fbaInventoryAndInboundServicesFees
	pt4ServiceFee := serviceFees
	pt4ExpenseAdvertising := roundMonthlyAmount(monthlyAdd(
		costOfAdvertising,
		refundForAdvertiser,
	))
	pt4ExpenseOtherFees := roundMonthlyAmount(monthlyAdd(
		adjustments,
		liquidationsFees,
		otherTransactionFees,
		otherTransactionFeeRefunds,
	))
	pt4ExpenseTotal := roundMonthlyAmount(monthlyAdd(
		pt4ExpenseSellingFee,
		pt4ExpenseFBAFee,
		pt4ExpenseInventoryFee,
		pt4ServiceFee,
		pt4ExpenseAdvertising,
		pt4ExpenseOtherFees,
	))
	amazonPayBack := roundMonthlyAmount(monthlyAdd(
		pt4IncomeTotal,
		pt4ExpenseTotal,
		expenseVATTotal,
	))
	amazonCard := monthlySumField(classified["debt"], "total")
	advertisingPercentage := monthlySafeDivPercent(costOfAdvertising, incomeTotal)

	pt3 := monthlyAmountMap{
		"income_product_sales_non_fba":                    productSalesNonFBA,
		"income_product_sale_refunds_non_fba":             productSaleRefundsNonFBA,
		"income_fba_product_sales":                        fbaProductSales,
		"income_fba_product_sale_refunds":                 fbaProductSaleRefunds,
		"income_fba_inventory_credit":                     fbaInventoryCredit,
		"income_fba_liquidation_proceeds":                 fbaLiquidationProceeds,
		"income_shipping_credits":                         shippingCredits,
		"income_shipping_credit_refunds":                  shippingCreditRefunds,
		"income_gift_wrap_credits":                        giftWrapCredits,
		"income_gift_wrap_credits_refunds":                giftWrapCreditsRefunds,
		"income_promotional_rebates":                      promotionalRebates,
		"income_promotional_rebate_refunds":               promotionalRebateRefunds,
		"income_a_to_z_guarantee_claims":                  new(big.Rat),
		"income_chargebacks":                              chargebacks,
		"income_safe_t_reimbursement":                     new(big.Rat),
		"income_total":                                    incomeTotal,
		"income_vat_total":                                incomeVATTotal,
		"income_sales_with_tax":                           incomeSalesWithTax,
		"expense_seller_fulfilled_selling_fees":           sellerFulfilledSellingFees,
		"expense_fba_selling_fees":                        fbaSellingFees,
		"expense_selling_fee_refunds":                     sellingFeeRefunds,
		"expense_fba_transaction_fees":                    fbaTransactionFeesTotal,
		"expense_fba_transaction_fee_refunds":             fbaTransactionFeeRefunds,
		"expense_other_transaction_fees":                  otherTransactionFees,
		"expense_other_transaction_fee_refunds":           otherTransactionFeeRefunds,
		"expense_fba_inventory_and_inbound_services_fees": fbaInventoryAndInboundServicesFees,
		"expense_shipping_label_purchases":                new(big.Rat),
		"expense_shipping_label_refunds":                  new(big.Rat),
		"expense_carrier_shipping_label_adjustments":      new(big.Rat),
		"expense_service_fees":                            serviceFees,
		"expense_refund_administration_fees":              new(big.Rat),
		"expense_adjustments":                             adjustments,
		"expense_cost_of_advertising":                     costOfAdvertising,
		"expense_refund_for_advertiser":                   refundForAdvertiser,
		"expense_liquidations_fees":                       liquidationsFees,
		"expense_receivables":                             new(big.Rat),
		"expense_deductions":                              new(big.Rat),
		"expense_amazon_shipping_charge_adjustments":      new(big.Rat),
		"expense_total":                                   expenseTotal,
		"amazon_pay_back":                                 amazonPayBack,
		"advertising_percentage":                          advertisingPercentage,
	}
	pt4 := monthlyAmountMap{
		"income_sales":              pt4IncomeSales,
		"income_refund":             pt4IncomeRefund,
		"income_adjustment":         pt4IncomeAdjustment,
		"income_other":              pt4IncomeOther,
		"income_total":              pt4IncomeTotal,
		"expense_selling_fee":       pt4ExpenseSellingFee,
		"expense_fba_fee":           pt4ExpenseFBAFee,
		"expense_inventory_fee":     pt4ExpenseInventoryFee,
		"expense_service_fee":       pt4ServiceFee,
		"expense_advertising":       pt4ExpenseAdvertising,
		"expense_other_fees":        pt4ExpenseOtherFees,
		"expense_total":             pt4ExpenseTotal,
		"expense_vat_total":         expenseVATTotal,
		"amazon_pay_back":           amazonPayBack,
		"credit_card_deduction_usd": amazonCard,
	}
	return pt3, pt4
}

func monthlyVATMetrics(
	classified monthlyClassifiedRows,
	country string,
) (*big.Rat, *big.Rat, *big.Rat) {
	allSalesRows := append(
		append([]*monthlyPaymentRow{}, classified["order"]...),
		classified["refund"]...,
	)
	netSales := roundMonthlyAmount(monthlySumField(allSalesRows, "product sales"))
	normalized := strings.ToUpper(strings.TrimSpace(country))
	if normalized != "DE" && normalized != "UK" {
		return new(big.Rat), netSales, new(big.Rat)
	}
	withheld := roundMonthlyAmount(monthlySumField(allSalesRows, "marketplace withheld tax"))
	salesWithTax := roundMonthlyAmount(new(big.Rat).Sub(netSales, withheld))
	return withheld, salesWithTax, withheld
}

func monthlySumField(rows []*monthlyPaymentRow, field string) *big.Rat {
	sum := new(big.Rat)
	for _, row := range rows {
		if row == nil {
			continue
		}
		if amount := row.amounts[field]; amount != nil {
			sum.Add(sum, amount)
		}
	}
	return roundMonthlyAmount(sum)
}

func roundMonthlyAmount(value *big.Rat) *big.Rat {
	if value == nil {
		return new(big.Rat)
	}
	scale := big.NewInt(100)
	scaled := new(big.Rat).Mul(value, new(big.Rat).SetInt(scale))
	quotient := new(big.Int)
	remainder := new(big.Int)
	quotient.QuoRem(scaled.Num(), scaled.Denom(), remainder)
	absoluteRemainder := new(big.Int).Abs(remainder)
	if new(big.Int).Lsh(absoluteRemainder, 1).Cmp(scaled.Denom()) >= 0 {
		if scaled.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(quotient, scale)
}

func monthlyAdd(values ...*big.Rat) *big.Rat {
	sum := new(big.Rat)
	for _, value := range values {
		if value != nil {
			sum.Add(sum, value)
		}
	}
	return sum
}

func monthlySafeDivPercent(numerator, denominator *big.Rat) *big.Rat {
	if denominator == nil || denominator.Sign() == 0 {
		return new(big.Rat)
	}
	absoluteNumerator := new(big.Rat).Abs(numerator)
	value := new(big.Rat).Quo(absoluteNumerator, denominator)
	value.Mul(value, big.NewRat(100, 1))
	return monthlyRoundRatio(value)
}

func monthlyRoundRatio(value *big.Rat) *big.Rat {
	if value == nil {
		return new(big.Rat)
	}
	scale := big.NewInt(10000)
	scaled := new(big.Rat).Mul(value, new(big.Rat).SetInt(scale))
	quotient := new(big.Int)
	remainder := new(big.Int)
	quotient.QuoRem(scaled.Num(), scaled.Denom(), remainder)
	absoluteRemainder := new(big.Int).Abs(remainder)
	if new(big.Int).Lsh(absoluteRemainder, 1).Cmp(scaled.Denom()) >= 0 {
		if scaled.Sign() < 0 {
			quotient.Sub(quotient, big.NewInt(1))
		} else {
			quotient.Add(quotient, big.NewInt(1))
		}
	}
	return new(big.Rat).SetFrac(quotient, scale)
}

func formatMonthlyAmountMap(values monthlyAmountMap) map[string]string {
	formatted := make(map[string]string, len(values))
	for key, value := range values {
		places := 2
		if key == "advertising_percentage" {
			places = 4
		}
		formatted[key] = formatMonthlyRat(value, places)
	}
	return formatted
}

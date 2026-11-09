package store

import (
	"context"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
)

type monthlyFinancialTransaction struct {
	TransactionType        string
	Description            string
	Fulfillment            string
	ProductSales           float64
	ShippingCredits        float64
	GiftWrapCredits        float64
	PromotionalRebates     float64
	MarketplaceWithheldTax float64
	SellingFees            float64
	FBAFees                float64
	OtherTransactionFees   float64
	OtherAmount            float64
	Total                  float64
}

type monthlyFinancialClassified map[string][]monthlyFinancialTransaction

func (s *MonthlyReportStore) RecalculateFinancialSeries(
	ctx context.Context,
	filter monthly_reports.MonthlyFinancialSeriesFilter,
) (*monthly_reports.MonthlyFinancialSeriesResponse, error) {
	if _, err := s.loadMonthlyFinancialProjectName(ctx, filter.ProjectID); err != nil {
		return nil, err
	}
	country := normalizeMonthlyFinancialCountry(filter.Country)
	err := s.RunInTx(ctx, func(
		txCtx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		transactionStore, ok := txStore.(*MonthlyReportStore)
		if !ok {
			return monthly_reports.ErrReportNotFound
		}
		rows, err := transactionStore.db.Query(
			txCtx,
			`select id, project_name, report_month, country
			   from public.monthly_reports
			  where project_id = $1
			    and country = $2
			    and is_current = true
			  order by report_month asc, id asc
			  for update`,
			filter.ProjectID,
			country,
		)
		if err != nil {
			return err
		}
		defer rows.Close()

		type reportSnapshot struct {
			id          int64
			projectName string
			reportMonth string
			country     string
		}
		reports := make([]reportSnapshot, 0)
		for rows.Next() {
			var report reportSnapshot
			if err := rows.Scan(
				&report.id,
				&report.projectName,
				&report.reportMonth,
				&report.country,
			); err != nil {
				return err
			}
			reports = append(reports, report)
		}
		if err := rows.Err(); err != nil {
			return err
		}

		for _, report := range reports {
			transactions, err := loadMonthlyFinancialTransactions(
				txCtx,
				transactionStore.db,
				report.id,
			)
			if err != nil {
				return err
			}
			if len(transactions) == 0 {
				continue
			}
			pt3, pt4 := computeMonthlyFinancialCalculations(
				classifyMonthlyFinancialTransactions(transactions),
				report.country,
			)
			for _, table := range []string{
				monthlyReportPT3CalculationTable,
				monthlyReportPT4CalculationTable,
			} {
				if _, err := transactionStore.db.Exec(
					txCtx,
					`delete from public.`+table+` where report_id = $1`,
					report.id,
				); err != nil {
					return err
				}
			}
			if err := insertMonthlyReportPT3(
				txCtx,
				transactionStore.db,
				report.id,
				report.projectName,
				report.reportMonth,
				pt3,
			); err != nil {
				return err
			}
			if err := insertMonthlyReportPT4(
				txCtx,
				transactionStore.db,
				report.id,
				report.projectName,
				report.reportMonth,
				pt4,
			); err != nil {
				return err
			}
			if _, err := transactionStore.db.Exec(
				txCtx,
				`update public.monthly_reports
				    set calculation_version = greatest(calculation_version, 1),
				        computed_at = now(),
				        updated_at = now()
				  where id = $1`,
				report.id,
			); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.GetFinancialSeries(ctx, filter)
}

func loadMonthlyFinancialTransactions(
	ctx context.Context,
	db DB,
	reportID int64,
) ([]monthlyFinancialTransaction, error) {
	rows, err := db.Query(
		ctx,
		`select transaction_type,
		        coalesce(description, ''),
		        coalesce(fulfillment, ''),
		        coalesce(product_sales, 0)::float8,
		        coalesce(shipping_credits, 0)::float8,
		        coalesce(gift_wrap_credits, 0)::float8,
		        coalesce(promotional_rebates, 0)::float8,
		        coalesce(marketplace_withheld_tax, 0)::float8,
		        coalesce(selling_fees, 0)::float8,
		        coalesce(fba_fees, 0)::float8,
		        coalesce(other_transaction_fees, 0)::float8,
		        coalesce(other_amount, 0)::float8,
		        coalesce(total, 0)::float8
		   from public.monthly_report_transactions
		  where report_id = $1
		  order by source_row_no asc, id asc`,
		reportID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	transactions := make([]monthlyFinancialTransaction, 0)
	for rows.Next() {
		var transaction monthlyFinancialTransaction
		if err := rows.Scan(
			&transaction.TransactionType,
			&transaction.Description,
			&transaction.Fulfillment,
			&transaction.ProductSales,
			&transaction.ShippingCredits,
			&transaction.GiftWrapCredits,
			&transaction.PromotionalRebates,
			&transaction.MarketplaceWithheldTax,
			&transaction.SellingFees,
			&transaction.FBAFees,
			&transaction.OtherTransactionFees,
			&transaction.OtherAmount,
			&transaction.Total,
		); err != nil {
			return nil, err
		}
		transactions = append(transactions, transaction)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return transactions, nil
}

func classifyMonthlyFinancialTransactions(
	transactions []monthlyFinancialTransaction,
) monthlyFinancialClassified {
	classified := monthlyFinancialClassified{
		"order":                                  {},
		"refund":                                 {},
		"fba_customer_return_fee":                {},
		"amazon_fees_reversal":                   {},
		"chargeback_refund":                      {},
		"liquidation":                            {},
		"adjustment":                             {},
		"service_fee":                            {},
		"fba_inventory_fee":                      {},
		"amazon_fees":                            {},
		"fee_adjustment":                         {},
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
		"fee_adjustment_weight_dim":              {},
	}
	adjustmentExpenses := map[string]bool{
		"FBA Inventory Reimbursement - General Adjustment": true,
		"Non-subscription Fee Adjustment":                  true,
		"Other":                                            true,
		"Buyer Recharge":                                   true,
	}
	adExcluded := map[string]bool{
		"Cost of Advertising":   true,
		"Refund for Advertiser": true,
	}
	aglDescriptions := map[string]bool{
		"FBA International Freight Shipping Charge":         true,
		"FBA International Freight Duties and Taxes Charge": true,
	}
	const feeAdjustmentTarget = "Fee Adjustment - Weight and Dimension Change"

	for _, transaction := range transactions {
		rowType := normalizeMonthlyFinancialTransactionType(transaction.TransactionType)
		description := normalizeMonthlyFinancialDescription(transaction.Description)
		switch rowType {
		case "Order":
			classified["order"] = append(classified["order"], transaction)
			switch strings.TrimSpace(transaction.Fulfillment) {
			case "Amazon":
				classified["fba_order"] = append(classified["fba_order"], transaction)
			case "Seller":
				classified["fbm_order"] = append(classified["fbm_order"], transaction)
			}
		case "Refund":
			classified["refund"] = append(classified["refund"], transaction)
			switch strings.TrimSpace(transaction.Fulfillment) {
			case "Amazon":
				classified["fba_refund"] = append(classified["fba_refund"], transaction)
			case "Seller":
				classified["fbm_refund"] = append(classified["fbm_refund"], transaction)
			}
		case "FBA Customer Return Fee":
			classified["fba_customer_return_fee"] = append(
				classified["fba_customer_return_fee"],
				transaction,
			)
		case "Amazon Fees - Reversal":
			classified["amazon_fees_reversal"] = append(
				classified["amazon_fees_reversal"],
				transaction,
			)
			if !adExcluded[description] {
				classified["amazon_fees_and_service_fee_without_ad"] = append(
					classified["amazon_fees_and_service_fee_without_ad"],
					transaction,
				)
			}
		case "Amazon Fees", "Amazon Fees - Correction":
			classified["amazon_fees"] = append(classified["amazon_fees"], transaction)
			if !adExcluded[description] {
				classified["amazon_fees_and_service_fee_without_ad"] = append(
					classified["amazon_fees_and_service_fee_without_ad"],
					transaction,
				)
			}
		case "Chargeback Refund":
			classified["chargeback_refund"] = append(
				classified["chargeback_refund"],
				transaction,
			)
		case "Liquidations":
			classified["liquidation"] = append(classified["liquidation"], transaction)
		case "FBA Inventory Fee":
			classified["fba_inventory_fee"] = append(
				classified["fba_inventory_fee"],
				transaction,
			)
		case "Debt":
			classified["debt"] = append(classified["debt"], transaction)
		case "FBA Transaction Fees":
			if isMonthlyFinancialStorageFee(description) {
				classified["fba_inventory_and_inbound_fees"] = append(
					classified["fba_inventory_and_inbound_fees"],
					transaction,
				)
			} else {
				classified["fba_transaction_fees"] = append(
					classified["fba_transaction_fees"],
					transaction,
				)
			}
		case "Fee Adjustment":
			classified["fee_adjustment"] = append(classified["fee_adjustment"], transaction)
			if description == feeAdjustmentTarget {
				classified["fee_adjustment_weight_dim"] = append(
					classified["fee_adjustment_weight_dim"],
					transaction,
				)
			}
		case "Adjustment":
			classified["adjustment"] = append(classified["adjustment"], transaction)
			if adjustmentExpenses[description] {
				classified["adjustment_expense"] = append(
					classified["adjustment_expense"],
					transaction,
				)
			} else {
				classified["adjustment_income"] = append(
					classified["adjustment_income"],
					transaction,
				)
			}
		case "Service Fee":
			classified["service_fee"] = append(classified["service_fee"], transaction)
			if !adExcluded[description] {
				classified["amazon_fees_and_service_fee_without_ad"] = append(
					classified["amazon_fees_and_service_fee_without_ad"],
					transaction,
				)
			}
			switch description {
			case "Cost of Advertising":
				classified["advertising"] = append(classified["advertising"], transaction)
			case "Refund for Advertiser":
				classified["service_refund_for_advertiser"] = append(
					classified["service_refund_for_advertiser"],
					transaction,
				)
			default:
				if aglDescriptions[description] {
					classified["agl_selection"] = append(
						classified["agl_selection"],
						transaction,
					)
				}
			}
		}
	}
	return classified
}

func computeMonthlyFinancialCalculations(
	classified monthlyFinancialClassified,
	country string,
) (map[string]string, map[string]string) {
	order := classified["order"]
	refund := classified["refund"]
	fbaOrder := classified["fba_order"]
	fbmOrder := classified["fbm_order"]
	fbaRefund := classified["fba_refund"]
	fbmRefund := classified["fbm_refund"]
	adjustmentIncome := classified["adjustment_income"]
	adjustmentExpense := classified["adjustment_expense"]
	liquidation := classified["liquidation"]
	advertising := classified["advertising"]
	amazonFeesWithoutAdvertising := classified["amazon_fees_and_service_fee_without_ad"]

	productSalesNonFBA := monthlyFinancialSum(fbmOrder, func(row monthlyFinancialTransaction) float64 {
		return row.ProductSales
	})
	productSaleRefundsNonFBA := monthlyFinancialSum(fbmRefund, func(row monthlyFinancialTransaction) float64 {
		return row.ProductSales
	})
	fbaProductSales := monthlyFinancialSum(fbaOrder, func(row monthlyFinancialTransaction) float64 {
		return row.ProductSales
	})
	fbaProductSaleRefunds := monthlyRoundMoney(
		monthlyFinancialSum(fbaRefund, func(row monthlyFinancialTransaction) float64 {
			return row.ProductSales
		}) +
			monthlyFinancialSum(fbaRefund, func(row monthlyFinancialTransaction) float64 {
				return row.OtherAmount
			}),
	)
	fbaInventoryCredit := monthlyFinancialSum(adjustmentIncome, func(row monthlyFinancialTransaction) float64 {
		return row.Total
	})
	fbaLiquidationProceeds := monthlyFinancialSum(liquidation, func(row monthlyFinancialTransaction) float64 {
		return row.ProductSales
	})
	shippingCredits := monthlyFinancialSum(order, func(row monthlyFinancialTransaction) float64 {
		return row.ShippingCredits
	})
	shippingCreditRefunds := monthlyFinancialSum(refund, func(row monthlyFinancialTransaction) float64 {
		return row.ShippingCredits
	})
	giftWrapCredits := monthlyFinancialSum(order, func(row monthlyFinancialTransaction) float64 {
		return row.GiftWrapCredits
	})
	giftWrapCreditRefunds := monthlyFinancialSum(refund, func(row monthlyFinancialTransaction) float64 {
		return row.GiftWrapCredits
	})
	promotionalRebates := monthlyFinancialSum(order, func(row monthlyFinancialTransaction) float64 {
		return row.PromotionalRebates
	})
	promotionalRebateRefunds := monthlyFinancialSum(refund, func(row monthlyFinancialTransaction) float64 {
		return row.PromotionalRebates
	})
	chargebacks := monthlyFinancialSum(classified["chargeback_refund"], func(row monthlyFinancialTransaction) float64 {
		return row.Total
	})

	incomeTotal := monthlyRoundMoney(
		productSalesNonFBA +
			productSaleRefundsNonFBA +
			fbaProductSales +
			fbaProductSaleRefunds +
			fbaInventoryCredit +
			fbaLiquidationProceeds +
			shippingCredits +
			shippingCreditRefunds +
			giftWrapCredits +
			giftWrapCreditRefunds +
			promotionalRebates +
			promotionalRebateRefunds +
			chargebacks,
	)
	incomeVATTotal, incomeSalesWithTax, expenseVATTotal := monthlyFinancialVAT(
		order,
		refund,
		country,
	)
	if incomeVATTotal != 0 {
		incomeTotal = monthlyRoundMoney(incomeTotal - incomeVATTotal)
	}

	sellerFulfilledSellingFees := monthlyFinancialSum(fbmOrder, func(row monthlyFinancialTransaction) float64 {
		return row.SellingFees
	})
	fbaSellingFees := monthlyFinancialSum(fbaOrder, func(row monthlyFinancialTransaction) float64 {
		return row.SellingFees
	})
	sellingFeeRefunds := monthlyFinancialSum(refund, func(row monthlyFinancialTransaction) float64 {
		return row.SellingFees
	})
	fbaTransactionFeesTotal := monthlyRoundMoney(
		monthlyFinancialSum(fbaOrder, func(row monthlyFinancialTransaction) float64 {
			return row.FBAFees
		}) +
			monthlyFinancialSum(classified["fba_transaction_fees"], func(row monthlyFinancialTransaction) float64 {
				return row.FBAFees
			}),
	)
	feeAdjustment := monthlyFinancialSum(classified["fee_adjustment_weight_dim"], func(row monthlyFinancialTransaction) float64 {
		return row.Total
	})
	fbaTransactionFeeRefunds := monthlyRoundMoney(
		monthlyFinancialSum(fbaRefund, func(row monthlyFinancialTransaction) float64 {
			return row.FBAFees
		}) + feeAdjustment,
	)
	otherTransactionFees := monthlyFinancialSum(order, func(row monthlyFinancialTransaction) float64 {
		return row.OtherTransactionFees
	})
	otherTransactionFeeRefunds := monthlyFinancialSum(refund, func(row monthlyFinancialTransaction) float64 {
		return row.OtherTransactionFees
	})
	fbaInventoryAndInboundServicesFees := monthlyRoundMoney(
		monthlyFinancialSum(classified["fba_inventory_fee"], func(row monthlyFinancialTransaction) float64 {
			return row.Total
		}) +
			monthlyFinancialSum(classified["fba_inventory_and_inbound_fees"], func(row monthlyFinancialTransaction) float64 {
				return row.Total
			}) +
			monthlyFinancialSum(classified["fba_customer_return_fee"], func(row monthlyFinancialTransaction) float64 {
				return row.Total
			}) +
			monthlyFinancialSum(classified["agl_selection"], func(row monthlyFinancialTransaction) float64 {
				return row.Total
			}),
	)
	serviceFees := monthlyRoundMoney(monthlyFinancialSum(
		amazonFeesWithoutAdvertising,
		func(row monthlyFinancialTransaction) float64 { return row.Total },
	))
	adjustments := monthlyFinancialSum(adjustmentExpense, func(row monthlyFinancialTransaction) float64 {
		return row.Total
	})
	costOfAdvertising := monthlyFinancialSum(advertising, func(row monthlyFinancialTransaction) float64 {
		return row.Total
	})
	refundForAdvertiser := monthlyFinancialSum(
		classified["service_refund_for_advertiser"],
		func(row monthlyFinancialTransaction) float64 { return row.Total },
	)
	liquidationsFees := monthlyFinancialSum(liquidation, func(row monthlyFinancialTransaction) float64 {
		return row.OtherTransactionFees
	})

	expenseTotal := monthlyRoundMoney(
		sellerFulfilledSellingFees +
			fbaSellingFees +
			sellingFeeRefunds +
			fbaTransactionFeesTotal +
			fbaTransactionFeeRefunds +
			otherTransactionFees +
			otherTransactionFeeRefunds +
			fbaInventoryAndInboundServicesFees +
			serviceFees +
			adjustments +
			costOfAdvertising +
			refundForAdvertiser +
			liquidationsFees,
	)

	pt4IncomeSales := monthlyRoundMoney(
		productSalesNonFBA +
			fbaProductSales +
			shippingCredits +
			giftWrapCredits +
			promotionalRebates -
			incomeVATTotal,
	)
	pt4IncomeRefund := monthlyRoundMoney(
		productSaleRefundsNonFBA +
			fbaProductSaleRefunds +
			shippingCreditRefunds +
			giftWrapCreditRefunds +
			promotionalRebateRefunds,
	)
	pt4IncomeAdjustment := monthlyRoundMoney(fbaInventoryCredit + fbaLiquidationProceeds)
	pt4IncomeOther := monthlyRoundMoney(chargebacks)
	pt4IncomeTotal := monthlyRoundMoney(
		pt4IncomeSales + pt4IncomeRefund + pt4IncomeAdjustment + pt4IncomeOther,
	)
	pt4ExpenseSellingFee := monthlyRoundMoney(
		sellerFulfilledSellingFees + fbaSellingFees + sellingFeeRefunds,
	)
	pt4ExpenseFBAFee := monthlyRoundMoney(
		fbaTransactionFeesTotal + fbaTransactionFeeRefunds,
	)
	pt4ExpenseInventoryFee := fbaInventoryAndInboundServicesFees
	pt4ServiceFee := serviceFees
	pt4ExpenseAdvertising := monthlyRoundMoney(costOfAdvertising + refundForAdvertiser)
	pt4ExpenseOtherFees := monthlyRoundMoney(
		adjustments +
			liquidationsFees +
			otherTransactionFees +
			otherTransactionFeeRefunds,
	)
	pt4ExpenseTotal := monthlyRoundMoney(
		pt4ExpenseSellingFee +
			pt4ExpenseFBAFee +
			pt4ExpenseInventoryFee +
			pt4ServiceFee +
			pt4ExpenseAdvertising +
			pt4ExpenseOtherFees,
	)
	amazonPayBack := monthlyRoundMoney(
		pt4IncomeTotal + pt4ExpenseTotal + expenseVATTotal,
	)
	advertisingPercentage := monthlyFinancialPercent(costOfAdvertising, incomeTotal)

	pt3 := map[string]float64{
		"income_product_sales_non_fba":                    productSalesNonFBA,
		"income_product_sale_refunds_non_fba":             productSaleRefundsNonFBA,
		"income_fba_product_sales":                        fbaProductSales,
		"income_fba_product_sale_refunds":                 fbaProductSaleRefunds,
		"income_fba_inventory_credit":                     fbaInventoryCredit,
		"income_fba_liquidation_proceeds":                 fbaLiquidationProceeds,
		"income_shipping_credits":                         shippingCredits,
		"income_shipping_credit_refunds":                  shippingCreditRefunds,
		"income_gift_wrap_credits":                        giftWrapCredits,
		"income_gift_wrap_credits_refunds":                giftWrapCreditRefunds,
		"income_promotional_rebates":                      promotionalRebates,
		"income_promotional_rebate_refunds":               promotionalRebateRefunds,
		"income_a_to_z_guarantee_claims":                  0,
		"income_chargebacks":                              chargebacks,
		"income_safe_t_reimbursement":                     0,
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
		"expense_shipping_label_purchases":                0,
		"expense_shipping_label_refunds":                  0,
		"expense_carrier_shipping_label_adjustments":      0,
		"expense_service_fees":                            serviceFees,
		"expense_refund_administration_fees":              0,
		"expense_adjustments":                             adjustments,
		"expense_cost_of_advertising":                     costOfAdvertising,
		"expense_refund_for_advertiser":                   refundForAdvertiser,
		"expense_liquidations_fees":                       liquidationsFees,
		"expense_receivables":                             0,
		"expense_deductions":                              0,
		"expense_amazon_shipping_charge_adjustments":      0,
		"expense_total":                                   expenseTotal,
		"amazon_pay_back":                                 amazonPayBack,
		"advertising_percentage":                          advertisingPercentage,
	}
	pt4 := map[string]float64{
		"income_sales":          pt4IncomeSales,
		"income_refund":         pt4IncomeRefund,
		"income_adjustment":     pt4IncomeAdjustment,
		"income_other":          pt4IncomeOther,
		"income_total":          pt4IncomeTotal,
		"expense_selling_fee":   pt4ExpenseSellingFee,
		"expense_fba_fee":       pt4ExpenseFBAFee,
		"expense_inventory_fee": pt4ExpenseInventoryFee,
		"expense_service_fee":   pt4ServiceFee,
		"expense_advertising":   pt4ExpenseAdvertising,
		"expense_other_fees":    pt4ExpenseOtherFees,
		"expense_total":         pt4ExpenseTotal,
		"expense_vat_total":     expenseVATTotal,
		"amazon_pay_back":       amazonPayBack,
		"credit_card_deduction_usd": monthlyFinancialSum(classified["debt"], func(row monthlyFinancialTransaction) float64 {
			return row.Total
		}),
	}
	return monthlyFinancialAmountStrings(pt3), monthlyFinancialAmountStrings(pt4)
}

func monthlyFinancialVAT(
	order []monthlyFinancialTransaction,
	refund []monthlyFinancialTransaction,
	country string,
) (float64, float64, float64) {
	allSales := append(append([]monthlyFinancialTransaction{}, order...), refund...)
	netSales := monthlyFinancialSum(allSales, func(row monthlyFinancialTransaction) float64 {
		return row.ProductSales
	})
	normalized := strings.ToUpper(strings.TrimSpace(country))
	if normalized != "DE" && normalized != "UK" {
		return 0, netSales, 0
	}
	withheld := monthlyFinancialSum(allSales, func(row monthlyFinancialTransaction) float64 {
		return row.MarketplaceWithheldTax
	})
	return withheld, monthlyRoundMoney(netSales - withheld), withheld
}

func monthlyFinancialSum(
	rows []monthlyFinancialTransaction,
	value func(monthlyFinancialTransaction) float64,
) float64 {
	sum := 0.0
	for _, row := range rows {
		sum += value(row)
	}
	return monthlyRoundMoney(sum)
}

func monthlyFinancialPercent(numerator, denominator float64) float64 {
	if denominator == 0 {
		return 0
	}
	value := math.Abs(numerator) / denominator * 100
	return math.Round(value*10000) / 10000
}

func monthlyFinancialAmountStrings(values map[string]float64) map[string]string {
	result := make(map[string]string, len(values))
	for key, value := range values {
		result[key] = strconv.FormatFloat(monthlyRoundMoney(value), 'f', 2, 64)
	}
	return result
}

func normalizeMonthlyFinancialTransactionType(value string) string {
	switch normalizeMonthlyFinancialToken(value) {
	case "order", "bestellung":
		return "Order"
	case "refund", "erstattung", "rueckerstattung":
		return "Refund"
	case "amazon fees", "gebuehren von amazon":
		return "Amazon Fees"
	case "service fee", "servicegebuehr":
		return "Service Fee"
	case "fba inventory fee", "versand durch amazon lagergebuehr":
		return "FBA Inventory Fee"
	case "fba transaction fees", "transaktionsgebuehren fuer versand durch amazon",
		"fulfilment by amazon (fba) transaction fees":
		return "FBA Transaction Fees"
	case "chargeback refund":
		return "Chargeback Refund"
	case "liquidations":
		return "Liquidations"
	case "adjustment", "anpassung":
		return "Adjustment"
	case "deal fee":
		return "Deal Fee"
	case "debt", "verbindlichkeit":
		return "Debt"
	case "fee adjustment":
		return "Fee Adjustment"
	default:
		return strings.TrimSpace(value)
	}
}

func normalizeMonthlyFinancialDescription(value string) string {
	switch normalizeMonthlyFinancialToken(value) {
	case "cost of advertising", "werbekosten":
		return "Cost of Advertising"
	case "refund for advertiser", "werbekosten-erstattung", "erstattung werbekosten":
		return "Refund for Advertiser"
	case "fba inventory reimbursement - general adjustment",
		"fba-bestandsentschaedigung - allgemeine anpassung",
		"versand durch amazon erstattung fuer lagerbestand - allgemeine anpassung":
		return "FBA Inventory Reimbursement - General Adjustment"
	case "non-subscription fee adjustment", "nicht-abonnement-gebu ehrenanpassung":
		return "Non-subscription Fee Adjustment"
	case "fba international freight shipping charge", "fba internationale frachtversandkosten":
		return "FBA International Freight Shipping Charge"
	case "fba international freight duties and taxes charge",
		"fba internationale frachtzoelle und steuern":
		return "FBA International Freight Duties and Taxes Charge"
	case "fee adjustment - weight and dimension change",
		"gebuehrenanpassung - gewichts- und massaenderung":
		return "Fee Adjustment - Weight and Dimension Change"
	default:
		return strings.TrimSpace(value)
	}
}

func normalizeMonthlyFinancialToken(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(strings.Trim(value, `"`)))
	normalized = strings.ReplaceAll(normalized, "\uFEFF", "")
	normalized = strings.NewReplacer(
		"ä", "ae",
		"ö", "oe",
		"ü", "ue",
		"ß", "ss",
	).Replace(normalized)
	return strings.Join(strings.Fields(normalized), " ")
}

func isMonthlyFinancialStorageFee(description string) bool {
	normalized := normalizeMonthlyFinancialToken(description)
	return strings.Contains(normalized, "storage fee") ||
		strings.Contains(normalized, "inventory storage") ||
		strings.Contains(normalized, "lagergebuehr")
}

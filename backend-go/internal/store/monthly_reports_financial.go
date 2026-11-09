package store

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
)

type monthlyFinancialStoredRow struct {
	ReportID int64
	monthly_reports.MonthlyFinancialSeriesRow
}

func (s *MonthlyReportStore) GetFinancialSeries(
	ctx context.Context,
	filter monthly_reports.MonthlyFinancialSeriesFilter,
) (*monthly_reports.MonthlyFinancialSeriesResponse, error) {
	projectName, err := s.loadMonthlyFinancialProjectName(ctx, filter.ProjectID)
	if err != nil {
		return nil, err
	}
	country := normalizeMonthlyFinancialCountry(filter.Country)

	rows, err := s.db.Query(
		ctx,
		`select report.id,
		        report.report_month,
		        coalesce(pt4.income_sales, 0)::float8,
		        coalesce(pt4.income_refund, 0)::float8,
		        coalesce(pt4.income_adjustment, 0)::float8,
		        coalesce(pt4.income_other, 0)::float8,
		        coalesce(pt4.expense_selling_fee, 0)::float8,
		        coalesce(pt4.expense_fba_fee, 0)::float8,
		        coalesce(pt4.expense_inventory_fee, 0)::float8,
		        coalesce(pt4.expense_service_fee, 0)::float8,
		        coalesce(pt4.expense_advertising, 0)::float8,
		        coalesce(pt4.expense_other_fees, 0)::float8,
		        coalesce(pt4.income_total, 0)::float8,
		        coalesce(pt4.expense_total, 0)::float8,
		        coalesce(pt4.amazon_pay_back, 0)::float8,
		        coalesce(
		          (to_jsonb(pt3)->>'income_vat_total')::numeric,
		          case when report.country in ('DE', 'UK') then vat.income_vat_total end,
		          0
		        )::float8,
		        coalesce(
		          (to_jsonb(pt4)->>'expense_vat_total')::numeric,
		          case when report.country in ('DE', 'UK') then vat.income_vat_total end,
		          0
		        )::float8,
		        coalesce(debt.credit_card_deduction_usd, 0)::float8,
		        (pt4.report_id is not null) as has_source_report
		   from public.monthly_reports report
		   left join public.monthly_report_pt4_calculation pt4
		     on pt4.report_id = report.id
		   left join public.monthly_report_pt3_calculation pt3
		     on pt3.report_id = report.id
		   left join lateral (
		     select coalesce(sum(txn.total), 0) as credit_card_deduction_usd
		       from public.monthly_report_transactions txn
		      where txn.report_id = report.id
		        and lower(btrim(txn.transaction_type)) in ('debt', 'verbindlichkeit')
		   ) debt on true
		   left join lateral (
		     select coalesce(sum(txn.marketplace_withheld_tax), 0) as income_vat_total
		       from public.monthly_report_transactions txn
		      where txn.report_id = report.id
		        and lower(btrim(txn.transaction_type)) in (
		          'order', 'refund', 'bestellung', 'erstattung', 'rueckerstattung'
		        )
		   ) vat on true
		  where report.project_id = $1
		    and report.country = $2
		    and report.is_current = true
		  order by report.report_month asc`,
		filter.ProjectID,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	storedRows := make([]monthlyFinancialStoredRow, 0)
	reportIDs := make([]int64, 0)
	months := make([]string, 0)
	for rows.Next() {
		var item monthlyFinancialStoredRow
		if err := rows.Scan(
			&item.ReportID,
			&item.ReportMonth,
			&item.IncomeSales,
			&item.IncomeRefund,
			&item.IncomeAdjustment,
			&item.IncomeOther,
			&item.ExpenseSellingFee,
			&item.ExpenseFBAFee,
			&item.ExpenseInventoryFee,
			&item.ExpenseServiceFee,
			&item.ExpenseAdvertising,
			&item.ExpenseOtherFees,
			&item.IncomeTotal,
			&item.ExpenseTotal,
			&item.AmazonPayBack,
			&item.IncomeVATTotal,
			&item.ExpenseVATTotal,
			&item.CreditCardDeductionUSD,
			&item.HasSourceReport,
		); err != nil {
			return nil, err
		}
		item.IncomeSalesWithTax = item.IncomeSales
		storedRows = append(storedRows, item)
		reportIDs = append(reportIDs, item.ReportID)
		months = append(months, item.ReportMonth)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	costTotals, err := s.loadMonthlyFinancialCostTotals(
		ctx,
		filter.ProjectID,
		country,
		reportIDs,
	)
	if err != nil {
		return nil, err
	}

	startDate, endDate, err := monthlyFinancialRange(
		months,
		filter.StartMonth,
		filter.EndMonth,
		time.Now(),
	)
	if err != nil {
		return nil, err
	}
	rowByMonth := make(map[string]monthly_reports.MonthlyFinancialSeriesRow, len(storedRows))
	for _, item := range storedRows {
		cost := costTotals[item.ReportID]
		item.FOBCostRMB = cost.fobCostRMB
		item.FirstLegCostRMB = cost.firstLegCostRMB
		rowByMonth[item.ReportMonth] = item.MonthlyFinancialSeriesRow
	}

	seriesRows := make([]monthly_reports.MonthlyFinancialSeriesRow, 0)
	for _, month := range monthlyFinancialMonths(startDate, endDate) {
		if row, ok := rowByMonth[month]; ok {
			seriesRows = append(seriesRows, row)
		} else if filter.FillMissing {
			seriesRows = append(seriesRows, monthly_reports.MonthlyFinancialSeriesRow{
				ReportMonth: month,
			})
		}
	}

	points := make([]monthly_reports.MonthlyFinancialTrendPoint, 0, len(seriesRows))
	var incomeTotalSum, expenseTotalSum, amazonPayBackSum, netAmountSum float64
	for _, row := range seriesRows {
		netAmount := monthlyRoundMoney(row.IncomeTotal + row.ExpenseTotal)
		point := monthly_reports.MonthlyFinancialTrendPoint{
			ReportMonth:     row.ReportMonth,
			IncomeTotal:     row.IncomeTotal,
			ExpenseTotal:    row.ExpenseTotal,
			AmazonPayBack:   row.AmazonPayBack,
			NetAmount:       netAmount,
			VATTotal:        0,
			HasSourceReport: row.HasSourceReport,
		}
		points = append(points, point)
		incomeTotalSum += point.IncomeTotal
		expenseTotalSum += point.ExpenseTotal
		amazonPayBackSum += point.AmazonPayBack
		netAmountSum += point.NetAmount
	}

	return &monthly_reports.MonthlyFinancialSeriesResponse{
		ProjectID:   filter.ProjectID,
		ProjectName: projectName,
		StartMonth:  startDate.Format("2006-01"),
		EndMonth:    endDate.Format("2006-01"),
		Rows:        seriesRows,
		Trend: monthly_reports.MonthlyFinancialTrend{
			IncomeTotalSum:   monthlyRoundMoney(incomeTotalSum),
			ExpenseTotalSum:  monthlyRoundMoney(expenseTotalSum),
			AmazonPayBackSum: monthlyRoundMoney(amazonPayBackSum),
			NetAmountSum:     monthlyRoundMoney(netAmountSum),
			Points:           points,
		},
	}, nil
}

func (s *MonthlyReportStore) GetAccountingDetail(
	ctx context.Context,
	filter monthly_reports.MonthlyFinancialAccountingFilter,
) (*monthly_reports.MonthlyFinancialAccountingDetailResponse, error) {
	country := normalizeMonthlyFinancialCountry(filter.Country)
	reportMonth, err := normalizeMonthlyFinancialMonth(filter.ReportMonth)
	if err != nil {
		return nil, err
	}
	var reportID int64
	var projectID int64
	var projectName, storedMonth, storedCountry string
	err = s.db.QueryRow(
		ctx,
		`select report.id, report.project_id, report.project_name,
		        report.report_month, report.country
		   from public.monthly_reports report
		   join public.monthly_report_pt3_calculation pt3
		     on pt3.report_id = report.id
		  where report.project_id = $1
		    and report.country = $2
		    and report.report_month = $3
		    and report.is_current = true
		    and report.status = 'success'::public.jobstatus
		  order by report.created_at desc
		  limit 1`,
		filter.ProjectID,
		country,
		reportMonth,
	).Scan(&reportID, &projectID, &projectName, &storedMonth, &storedCountry)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, monthly_reports.ErrReportNotFound
		}
		return nil, err
	}
	pt3, err := s.loadCalculationMap(
		ctx,
		monthlyReportPT3CalculationTable,
		reportID,
	)
	if err != nil {
		return nil, err
	}
	if pt3 == nil {
		return nil, monthly_reports.ErrReportNotFound
	}
	if _, exists := pt3["income_vat_total"]; !exists &&
		(storedCountry == "DE" || storedCountry == "UK") {
		var vatTotal float64
		if err := s.db.QueryRow(
			ctx,
			`select coalesce(sum(txn.marketplace_withheld_tax), 0)::float8
			   from public.monthly_report_transactions txn
			  where txn.report_id = $1
			    and lower(btrim(txn.transaction_type)) in (
			      'order', 'refund', 'bestellung', 'erstattung', 'rueckerstattung'
			    )`,
			reportID,
		).Scan(&vatTotal); err != nil {
			return nil, err
		}
		pt3["income_vat_total"] = monthlyRoundMoney(vatTotal)
	}
	return &monthly_reports.MonthlyFinancialAccountingDetailResponse{
		ProjectID:   projectID,
		ProjectName: projectName,
		ReportMonth: storedMonth,
		Rows:        monthlyFinancialAccountingRows(pt3, storedCountry),
	}, nil
}

func (s *MonthlyReportStore) ExportAccountingDetail(
	ctx context.Context,
	filter monthly_reports.MonthlyFinancialAccountingFilter,
) (*monthly_reports.MonthlyReportExport, error) {
	detail, err := s.GetAccountingDetail(ctx, filter)
	if err != nil {
		return nil, err
	}
	content, err := renderMonthlyAccountingDetailXLSX(detail)
	if err != nil {
		return nil, err
	}
	return &monthly_reports.MonthlyReportExport{
		Filename:    "accounting-detail.xlsx",
		ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		Content:     content,
		ProjectID:   detail.ProjectID,
	}, nil
}

func (s *MonthlyReportStore) loadMonthlyFinancialProjectName(
	ctx context.Context,
	projectID int64,
) (string, error) {
	var projectName string
	err := s.db.QueryRow(
		ctx,
		`select project_name from public.projects where id = $1`,
		projectID,
	).Scan(&projectName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", monthly_reports.ErrProjectNotFound
		}
		return "", err
	}
	return projectName, nil
}

type monthlyFinancialCost struct {
	fobCostRMB      float64
	firstLegCostRMB float64
}

func (s *MonthlyReportStore) loadMonthlyFinancialCostTotals(
	ctx context.Context,
	projectID int64,
	country string,
	reportIDs []int64,
) (map[int64]monthlyFinancialCost, error) {
	totals := make(map[int64]monthlyFinancialCost)
	if len(reportIDs) == 0 {
		return totals, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select report_totals.report_id,
		        coalesce(sum(report_totals.quantity * costs.fob_unit_cost), 0)::float8,
		        coalesce(sum(report_totals.quantity * costs.first_leg_cost_rmb), 0)::float8
		   from (
		     select txn.report_id, txn.sku,
		            sum(txn.quantity)::numeric as quantity
		       from public.monthly_report_transactions txn
		      where txn.report_id = any($1)
		        and txn.sku is not null
		        and lower(btrim(txn.transaction_type)) in ('order', 'bestellung')
		      group by txn.report_id, txn.sku
		   ) report_totals
		   join lateral (
		     select product_cost.fob_unit_cost, product_cost.first_leg_cost_rmb
		       from public.product_costs product_cost
		      where product_cost.project_id = $2
		        and product_cost.country = $3
		        and lower(btrim(product_cost.sku)) = lower(btrim(report_totals.sku))
		        and product_cost.is_active = true
		      order by product_cost.updated_at desc, product_cost.id desc
		      limit 1
		   ) costs on true
		  group by report_totals.report_id`,
		reportIDs,
		projectID,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var reportID int64
		var fobCost, firstLegCost float64
		if err := rows.Scan(&reportID, &fobCost, &firstLegCost); err != nil {
			return nil, err
		}
		totals[reportID] = monthlyFinancialCost{
			fobCostRMB:      monthlyRoundMoney(fobCost),
			firstLegCostRMB: monthlyRoundMoney(firstLegCost),
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return totals, nil
}

func normalizeMonthlyFinancialCountry(country string) string {
	switch strings.ToUpper(strings.TrimSpace(country)) {
	case "DE":
		return "DE"
	case "UK", "GB":
		return "UK"
	default:
		return "US"
	}
}

func normalizeMonthlyFinancialMonth(raw string) (string, error) {
	parsed, err := time.Parse("2006-01", strings.TrimSpace(raw))
	if err != nil {
		return "", fmt.Errorf("%w: month must be YYYY-MM", monthly_reports.ErrInvalidFinancialRange)
	}
	return parsed.Format("2006-01"), nil
}

func monthlyFinancialRange(
	monthValues []string,
	startMonth string,
	endMonth string,
	now time.Time,
) (time.Time, time.Time, error) {
	startDate, err := monthlyFinancialOptionalMonth(startMonth)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	endDate, err := monthlyFinancialOptionalMonth(endMonth)
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	currentMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	var earliest time.Time
	for _, month := range monthValues {
		candidate, parseErr := monthlyFinancialOptionalMonth(month)
		if parseErr != nil {
			continue
		}
		if earliest.IsZero() || candidate.Before(earliest) {
			earliest = candidate
		}
	}

	switch {
	case startDate.IsZero() && endDate.IsZero():
		endDate = currentMonth
		startDate = monthlyAddMonths(endDate, -11)
		if !earliest.IsZero() && earliest.After(startDate) {
			startDate = earliest
		}
	case startDate.IsZero():
		startDate = monthlyAddMonths(endDate, -11)
		if !earliest.IsZero() && earliest.After(startDate) {
			startDate = earliest
		}
	case endDate.IsZero():
		endDate = currentMonth
	}
	if startDate.After(endDate) {
		return time.Time{}, time.Time{}, fmt.Errorf(
			"%w: start_month cannot be greater than end_month",
			monthly_reports.ErrInvalidFinancialRange,
		)
	}
	return startDate, endDate, nil
}

func monthlyFinancialOptionalMonth(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse("2006-01", raw)
	if err != nil {
		return time.Time{}, fmt.Errorf(
			"%w: month must be YYYY-MM",
			monthly_reports.ErrInvalidFinancialRange,
		)
	}
	return parsed, nil
}

func monthlyAddMonths(value time.Time, months int) time.Time {
	return time.Date(
		value.Year(),
		value.Month()+time.Month(months),
		1,
		0,
		0,
		0,
		0,
		time.UTC,
	)
}

func monthlyFinancialMonths(startDate, endDate time.Time) []string {
	months := make([]string, 0)
	for current := startDate; !current.After(endDate); current = monthlyAddMonths(current, 1) {
		months = append(months, current.Format("2006-01"))
	}
	return months
}

func monthlyFinancialAccountingRows(
	pt3 map[string]float64,
	country string,
) []monthly_reports.MonthlyFinancialAccountingLine {
	currency := countryCurrency(country)
	incomeLines := []monthlyFinancialAccountingValue{
		{"Product sales (non-FBA)", "销售额（非FBA）", mapValue(pt3, "income_product_sales_non_fba"), "FBM 订单-订单金额"},
		{"Product sale refunds (non-FBA)", "销售额退款（非FBA）", mapValue(pt3, "income_product_sale_refunds_non_fba"), "FBM 退款-订单金额"},
		{"FBA product sales", "销售额（FBA）", mapValue(pt3, "income_fba_product_sales"), "FBA 订单-订单金额"},
		{"FBA product sale refunds", "销售额退款（FBA）", mapValue(pt3, "income_fba_product_sale_refunds"), "FBA 退款-订单金额 + 其他金额"},
		{"FBA inventory credit", "FBA库存赔偿（FBA）", mapValue(pt3, "income_fba_inventory_credit"), "FBA库存赔偿-总计"},
		{"FBA liquidation proceeds", "FBA清算收入", mapValue(pt3, "income_fba_liquidation_proceeds"), "清算费用-订单金额"},
		{"Shipping credits", "运费收入", mapValue(pt3, "income_shipping_credits"), "所有订单-运费金额"},
		{"Shipping credit refunds", "运费退款", mapValue(pt3, "income_shipping_credit_refunds"), "所有退款-运费金额"},
		{"Gift wrap credits", "礼品包装收入", mapValue(pt3, "income_gift_wrap_credits"), "所有订单-礼品包装金额"},
		{"Gift wrap credit refunds", "礼品包装退款", mapValue(pt3, "income_gift_wrap_credits_refunds"), "所有退款-礼品包装金额"},
		{"Promotional rebates", "促销折扣", mapValue(pt3, "income_promotional_rebates"), "所有订单-促销折扣金额"},
		{"Promotional rebate refunds", "促销折扣退款", mapValue(pt3, "income_promotional_rebate_refunds"), "所有退款-促销折扣金额"},
		{"A-to-z Guarantee claims", "A-to-z保障索赔", mapValue(pt3, "income_a_to_z_guarantee_claims"), ""},
		{"Chargebacks", "拒付退款", mapValue(pt3, "income_chargebacks"), "拒付退款-总计"},
		{"SAFE-T reimbursement", "SAFE-T赔偿", mapValue(pt3, "income_safe_t_reimbursement"), ""},
		{"Product sales tax (gross)", "销售税（gross）", mapValue(pt3, "income_vat_total"), "所有订单/退款-产品销售税"},
	}
	expenseLines := []monthlyFinancialAccountingValue{
		{"Seller fulfilled selling fees", "卖家自配送销售佣金", mapValue(pt3, "expense_seller_fulfilled_selling_fees"), "FBM 订单-销售佣金"},
		{"FBA selling fees", "FBA销售佣金", mapValue(pt3, "expense_fba_selling_fees"), "FBA 订单-销售佣金"},
		{"Selling fee refunds", "销售佣金退款", mapValue(pt3, "expense_selling_fee_refunds"), "所有退款-销售佣金 + 退款管理费"},
		{"FBA transaction fees", "FBA派送费", mapValue(pt3, "expense_fba_transaction_fees"), "FBA 订单 - 派送费"},
		{"FBA transaction fee refunds", "FBA派送费退款", mapValue(pt3, "expense_fba_transaction_fee_refunds"), "FBA 退款 - 派送费 + 测量费"},
		{"Other transaction fees", "其他交易费用", mapValue(pt3, "expense_other_transaction_fees"), ""},
		{"Other transaction fee refunds", "其他交易费用退款", mapValue(pt3, "expense_other_transaction_fee_refunds"), ""},
		{"FBA inventory and inbound services fees", "FBA库存和入库服务费", mapValue(pt3, "expense_fba_inventory_and_inbound_services_fees"), "FBA仓储及入库服务费 - 总计"},
		{"Shipping label purchases", "购买配送标签", mapValue(pt3, "expense_shipping_label_purchases"), ""},
		{"Shipping label refunds", "配送标签退款", mapValue(pt3, "expense_shipping_label_refunds"), ""},
		{"Carrier shipping label adjustments", "承运商配送标签调整", mapValue(pt3, "expense_carrier_shipping_label_adjustments"), ""},
		{"Service fees", "服务费", mapValue(pt3, "expense_service_fees"), "服务费（不含广告）-总计"},
		{"Refund administration fees", "退款管理费", mapValue(pt3, "expense_refund_administration_fees"), "合并在销售佣金退款中扣除"},
		{"Adjustments", "调整项", mapValue(pt3, "expense_adjustments"), "其他赔偿调整-总计"},
		{"Cost of Advertising", "广告成本", mapValue(pt3, "expense_cost_of_advertising"), "广告费-总计"},
		{"Refund for Advertiser", "广告商退款", mapValue(pt3, "expense_refund_for_advertiser"), "广告退款-总计"},
		{"Liquidations fees", "清算处理费", mapValue(pt3, "expense_liquidations_fees"), "清算费用-其他交易费用"},
		{"Receivables", "应收账款", mapValue(pt3, "expense_receivables"), ""},
		{"Deductions", "扣款", mapValue(pt3, "expense_deductions"), ""},
		{"Amazon Shipping Charge Adjustments", "亚马逊配送运费调整", mapValue(pt3, "expense_amazon_shipping_charge_adjustments"), ""},
	}

	rows := make([]monthly_reports.MonthlyFinancialAccountingLine, 0, len(expenseLines)+2)
	incomePad := len(expenseLines) - len(incomeLines)
	if incomePad < 0 {
		incomePad = 0
	}
	blankIncome := monthlyFinancialAccountingValue{}
	for index := 0; index < incomePad; index++ {
		rows = append(rows, monthlyFinancialAccountingRow(blankIncome, expenseLines[index], currency, "detail"))
	}
	for index, incomeLine := range incomeLines {
		expenseIndex := incomePad + index
		expenseLine := monthlyFinancialAccountingValue{}
		if expenseIndex < len(expenseLines) {
			expenseLine = expenseLines[expenseIndex]
		}
		rows = append(rows, monthlyFinancialAccountingRow(incomeLine, expenseLine, currency, "detail"))
	}
	rows = append(rows, monthlyFinancialAccountingRow(
		monthlyFinancialAccountingValue{},
		monthlyFinancialAccountingValue{},
		currency,
		"spacer",
	))
	rows = append(rows, monthlyFinancialAccountingRow(
		monthlyFinancialAccountingValue{
			en:     "Total_Income",
			zh:     "合计销售额",
			amount: mapValue(pt3, "income_total"),
		},
		monthlyFinancialAccountingValue{
			en:     "Total_Expense",
			zh:     "合计费用",
			amount: mapValue(pt3, "expense_total"),
		},
		currency,
		"total",
	))
	return rows
}

type monthlyFinancialAccountingValue struct {
	en     string
	zh     string
	amount float64
	source string
}

func monthlyFinancialAccountingRow(
	income monthlyFinancialAccountingValue,
	expense monthlyFinancialAccountingValue,
	currency string,
	kind string,
) monthly_reports.MonthlyFinancialAccountingLine {
	currencyCopy := currency
	return monthly_reports.MonthlyFinancialAccountingLine{
		IncomeEN:         income.en,
		IncomeZH:         income.zh,
		IncomeAmountUSD:  monthlyRoundMoney(income.amount),
		IncomeSource:     income.source,
		ExpenseEN:        expense.en,
		ExpenseZH:        expense.zh,
		ExpenseAmountUSD: monthlyRoundMoney(expense.amount),
		ExpenseSource:    expense.source,
		CurrencyCode:     &currencyCopy,
		Kind:             kind,
	}
}

func monthlyRoundMoney(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return math.Round(value*100) / 100
}

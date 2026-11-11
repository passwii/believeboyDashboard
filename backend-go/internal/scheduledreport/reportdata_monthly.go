package scheduledreport

import (
	"context"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

// MonthlyOptions controls BuildMonthlyReportData.
type MonthlyOptions struct {
	ProjectIDs    []int64
	Country       string
	ReferenceDate *time.Time
	Now           time.Time
}

// BuildMonthlyReportData assembles a month-scoped report payload for the email
// template. It reuses the daily query helpers with a calendar-month window.
func BuildMonthlyReportData(ctx context.Context, db store.DB, opts MonthlyOptions) (map[string]any, error) {
	country := normalizeReportCountry(opts.Country)
	if country == "" {
		country = "US"
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	reference := reportAnchorDate(country, now)
	if opts.ReferenceDate != nil {
		reference = dateOnly(*opts.ReferenceDate)
	}
	monthStart := time.Date(reference.Year(), reference.Month(), 1, 0, 0, 0, 0, time.UTC)
	monthEnd := monthStart.AddDate(0, 1, -1)
	if opts.ReferenceDate == nil && reference.Day() <= 2 {
		monthEnd = monthStart.AddDate(0, 0, -1)
		monthStart = time.Date(monthEnd.Year(), monthEnd.Month(), 1, 0, 0, 0, 0, time.UTC)
	}
	prevStart := monthStart.AddDate(0, -1, 0)
	prevEnd := monthStart.AddDate(0, 0, -1)

	_, salesTrend, _ := querySalesSnapshot(ctx, db, opts.ProjectIDs, country, monthStart, monthEnd)
	projectNames := queryProjectNames(ctx, db, opts.ProjectIDs)
	inventorySummary := queryInventorySummary(ctx, db, opts.ProjectIDs, country)
	shipmentSnapshot := queryShipmentSnapshot(ctx, db, opts.ProjectIDs, country)
	monthSales := queryPeriodSales(ctx, db, opts.ProjectIDs, country, monthStart, monthEnd)
	prevMonthSales := queryPeriodSales(ctx, db, opts.ProjectIDs, country, prevStart, prevEnd)
	topSKUs := queryTopSKUs(ctx, db, opts.ProjectIDs, country, monthStart, monthEnd, 5)
	oosSKUs, lowStockSKUs := queryInventoryAlerts(ctx, db, opts.ProjectIDs, country)
	ads := queryAds(ctx, db, opts.ProjectIDs, country, monthStart, monthEnd, false)
	returnQty, topReturns := queryReturns(ctx, db, opts.ProjectIDs, country, monthStart, monthEnd)

	inventory := map[string]any{
		"sku_count": inventorySummary["sku_count"], "oos_skus": oosSKUs,
		"low_stock_skus": lowStockSKUs, "total_available": inventorySummary["available_qty"],
		"in_transit": shipmentSnapshot["in_transit_qty"],
	}
	alertRows := make([]map[string]any, 0)
	for index, item := range oosSKUs {
		if index >= 3 {
			break
		}
		alertRows = append(alertRows, map[string]any{"badge_color": "#DC2626", "badge": "缺货", "sku": item["sku"], "qty": 0})
	}
	for index, item := range lowStockSKUs {
		if index >= 3 {
			break
		}
		alertRows = append(alertRows, map[string]any{"badge_color": "#F59E0B", "badge": "告急", "sku": item["sku"], "qty": item["available_qty"]})
	}
	monthQty := intValue(monthSales["week_qty"])
	monthAmount := toFloat(monthSales["week_amount"])
	prevQty := intValue(prevMonthSales["week_qty"])
	prevAmount := toFloat(prevMonthSales["week_amount"])
	qtyChange := 0.0
	if prevQty > 0 {
		qtyChange = float64(monthQty-prevQty) / float64(prevQty) * 100
	}
	amountChange := 0.0
	if prevAmount > 0 {
		amountChange = (monthAmount - prevAmount) / prevAmount * 100
	}
	returnRate := 0.0
	if monthQty > 0 {
		returnRate = round2(float64(returnQty) / float64(monthQty) * 100)
	}
	adDenominator := monthAmount
	adSpend := toFloat(ads["spend"])
	if adDenominator > 0 {
		ads["ad_ratio_all"] = round2(adSpend / adDenominator * 100)
	} else {
		ads["ad_ratio_all"] = 0.0
	}

	trendDays := make([]map[string]any, 0)
	startIndex := 0
	if len(salesTrend) > 7 {
		startIndex = len(salesTrend) - 7
	}
	for _, point := range salesTrend[startIndex:] {
		date := point["date"].(string)
		shortDate := date
		if len(date) >= 10 {
			shortDate = date[5:]
		}
		trendDays = append(trendDays, map[string]any{"date": shortDate, "qty": point["order_qty"]})
	}

	projectName := "全部项目"
	if len(projectNames) > 0 {
		projectName = joinProjectNames(projectNames)
	}
	dateRange := monthStart.Format("2006-01-02") + " ~ " + monthEnd.Format("2006-01-02")
	sales := map[string]any{
		"yesterday_qty": monthQty, "yesterday_amount": monthAmount,
		"prev_qty": prevQty, "change_pct": qtyChange,
	}
	weekSales := map[string]any{"week_qty": monthQty, "week_amount": monthAmount}
	prevWeekSales := map[string]any{"week_qty": prevQty, "week_amount": prevAmount}
	reportData := map[string]any{
		"sales": sales, "week_sales": weekSales, "prev_week_sales": prevWeekSales,
		"trend_days": salesTrend, "top_skus": topSKUs, "inventory": inventory,
		"ads": ads, "returns": map[string]any{"qty": returnQty, "rate": returnRate, "top_returns": topReturns},
		"country": country, "report_date": monthEnd.Format("2006-01-02"), "date_range": dateRange,
		"project_context": "", "sku_context": "", "sku_factory_info_text": "",
	}
	return map[string]any{
		"project_name": projectName, "country": country, "date_range": dateRange,
		"period_start": monthStart.Format("2006-01-02"), "period_end": monthEnd.Format("2006-01-02"),
		"prev_period_start": prevStart.Format("2006-01-02"), "prev_period_end": prevEnd.Format("2006-01-02"),
		"period7d_change_pct": qtyChange, "period7d_amount_change_pct": amountChange,
		"sales": sales, "week_sales": weekSales, "prev_week_sales": prevWeekSales,
		"trend_days": trendDays, "top_skus": topSKUs,
		"sku_sales_detail": querySkuSalesDetail(ctx, db, opts.ProjectIDs, country, monthStart, monthEnd),
		"inventory":        inventory, "alert_rows": alertRows, "ads": ads,
		"returns":    map[string]any{"qty": returnQty, "rate": returnRate, "top_returns": topReturns},
		"ai_summary": "", "report_date": monthEnd.Format("2006-01-02"),
		"project_context": "", "sku_context": "", "sku_factory_info_text": "",
		"ai_payload": reportData,
	}, nil
}

func joinProjectNames(names []string) string {
	result := ""
	for index, name := range names {
		if index > 0 {
			result += ", "
		}
		result += name
	}
	return result
}

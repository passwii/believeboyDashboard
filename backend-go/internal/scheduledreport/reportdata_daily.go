// Package scheduledreport ports FastAPI's scheduled-report data assembly.
package scheduledreport

import (
	"context"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

// DailyOptions controls BuildDailyReportData.
type DailyOptions struct {
	ProjectIDs    []int64
	Country       string
	Frequency     string
	ReferenceDate *time.Time
	Now           time.Time
}

func normalizeReportCountry(country string) string {
	normalized := strings.ToUpper(strings.TrimSpace(country))
	switch normalized {
	case "USA", "US":
		return "US"
	case "DE", "DEU", "德国":
		return "DE"
	case "UK", "GB", "GBR", "英国":
		return "UK"
	default:
		return normalized
	}
}

func countryLocation(country string) *time.Location {
	switch normalizeReportCountry(country) {
	case "US", "CA":
		if location, err := time.LoadLocation("America/Los_Angeles"); err == nil {
			return location
		}
	case "DE":
		if location, err := time.LoadLocation("Europe/Berlin"); err == nil {
			return location
		}
	case "UK":
		if location, err := time.LoadLocation("Europe/London"); err == nil {
			return location
		}
	case "JP":
		if location, err := time.LoadLocation("Asia/Tokyo"); err == nil {
			return location
		}
	}
	return time.UTC
}

func dateOnly(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func reportAnchorDate(country string, now time.Time) time.Time {
	countryToday := dateOnly(now.In(countryLocation(country)))
	serverYesterday := dateOnly(now).AddDate(0, 0, -1)
	if countryToday.Before(serverYesterday) {
		return countryToday
	}
	return serverYesterday
}

func safePctChange(current, previous float64) (float64, string) {
	if previous == 0 {
		return 0, "neutral"
	}
	change := (current - previous) / previous * 100
	rounded := math.Round(change*100) / 100
	if math.Abs(change) < 0.5 {
		return rounded, "neutral"
	}
	if change > 0 {
		return rounded, "up"
	}
	return rounded, "down"
}

func round2(value float64) float64 {
	return math.Round(value*100) / 100
}

func salesAmountExpr(country string) string {
	country = normalizeReportCountry(country)
	net := "coalesce(item_price, 0) + coalesce(shipping_price, 0)"
	if country == "DE" || country == "UK" {
		return net + " + coalesce(item_tax, 0) + coalesce(shipping_tax, 0)"
	}
	return net
}

func buildProjectFilter(column string, argIndex int, projectIDs []int64) (string, []any) {
	if len(projectIDs) == 0 {
		return "", nil
	}
	return fmt.Sprintf(" and %s = any($%d)", column, argIndex), []any{projectIDs}
}

// BuildDailyReportData mirrors report_builder_daily.build_report_email_data
// for the email/AI payload fields. Project/SKU context enrichment is not
// ported yet (empty strings), matching the current AI-summary scope.
func BuildDailyReportData(ctx context.Context, db store.DB, opts DailyOptions) (map[string]any, error) {
	country := normalizeReportCountry(opts.Country)
	if country == "" {
		country = "US"
	}
	frequency := opts.Frequency
	if frequency == "" {
		frequency = "daily"
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	today := reportAnchorDate(country, now)
	if opts.ReferenceDate != nil {
		today = dateOnly(*opts.ReferenceDate)
	}
	periodStart := today.AddDate(0, 0, -6)
	prevPeriodStart := periodStart.AddDate(0, 0, -7)
	prevPeriodEnd := periodStart.AddDate(0, 0, -1)

	salesSnapshot, salesTrend, p7dSalesQty := querySalesSnapshot(ctx, db, opts.ProjectIDs, country, periodStart, today)
	projectNames := queryProjectNames(ctx, db, opts.ProjectIDs)
	inventorySummary := queryInventorySummary(ctx, db, opts.ProjectIDs, country)
	shipmentSnapshot := queryShipmentSnapshot(ctx, db, opts.ProjectIDs, country)
	weekSales := map[string]any{
		"week_qty":    p7dSalesQty,
		"week_amount": sumTrendAmount(salesTrend),
	}
	prevWeekSales := queryPeriodSales(ctx, db, opts.ProjectIDs, country, prevPeriodStart, prevPeriodEnd)

	trendDays := make([]map[string]any, 0, len(salesTrend))
	start := 0
	if len(salesTrend) > 7 {
		start = len(salesTrend) - 7
	}
	for _, point := range salesTrend[start:] {
		date := point["date"].(string)
		shortDate := date
		if len(date) >= 10 {
			shortDate = date[5:]
		}
		trendDays = append(trendDays, map[string]any{"date": shortDate, "qty": point["order_qty"]})
	}

	skuSalesDetail := querySkuSalesDetail(ctx, db, opts.ProjectIDs, country, today, today)
	topSKUs := queryTopSKUs(ctx, db, opts.ProjectIDs, country, periodStart, today, 5)
	oosSKUs, lowStockSKUs := queryInventoryAlerts(ctx, db, opts.ProjectIDs, country)

	inventory := map[string]any{
		"sku_count":       inventorySummary["sku_count"],
		"oos_skus":        oosSKUs,
		"low_stock_skus":  lowStockSKUs,
		"total_available": inventorySummary["available_qty"],
		"in_transit":      shipmentSnapshot["in_transit_qty"],
	}

	alertRows := make([]map[string]any, 0)
	for index, item := range oosSKUs {
		if index >= 3 {
			break
		}
		alertRows = append(alertRows, map[string]any{
			"badge_color": "#DC2626", "badge": "缺货",
			"sku": item["sku"], "qty": 0,
		})
	}
	for index, item := range lowStockSKUs {
		if index >= 3 {
			break
		}
		alertRows = append(alertRows, map[string]any{
			"badge_color": "#F59E0B", "badge": "告急",
			"sku": item["sku"], "qty": item["available_qty"],
		})
	}

	var ads map[string]any
	adRatioDenominator := 0.0
	if frequency == "daily" {
		ads = queryAds(ctx, db, opts.ProjectIDs, country, today, today, true)
		adRatioDenominator = toFloat(salesSnapshot["today_sales_amount"])
	} else {
		ads = queryAds(ctx, db, opts.ProjectIDs, country, periodStart, today, false)
		adRatioDenominator = toFloat(weekSales["week_amount"])
	}
	adSpend := toFloat(ads["spend"])
	if adRatioDenominator > 0 {
		ads["ad_ratio_all"] = round2(adSpend / adRatioDenominator * 100)
	} else {
		ads["ad_ratio_all"] = 0.0
	}

	returnQty, topReturns := queryReturns(ctx, db, opts.ProjectIDs, country, periodStart, today)
	returnRate := 0.0
	if p7dSalesQty > 0 {
		returnRate = round2(float64(returnQty) / float64(p7dSalesQty) * 100)
	}
	returns := map[string]any{
		"qty":         returnQty,
		"rate":        returnRate,
		"top_returns": topReturns,
	}

	sales := map[string]any{
		"yesterday_qty":    salesSnapshot["today_order_qty"],
		"yesterday_amount": salesSnapshot["today_sales_amount"],
		"prev_qty":         salesSnapshot["prev_order_qty"],
		"change_pct":       salesSnapshot["order_qty_change_pct"],
	}

	projectName := "全部项目"
	if len(projectNames) > 0 {
		projectName = strings.Join(projectNames, ", ")
	}
	dateRange := periodStart.Format("2006-01-02") + " ~ " + today.Format("2006-01-02")

	reportData := map[string]any{
		"sales":                 sales,
		"week_sales":            weekSales,
		"prev_week_sales":       prevWeekSales,
		"trend_days":            salesTrend,
		"top_skus":              topSKUs,
		"inventory":             inventory,
		"ads":                   ads,
		"returns":               returns,
		"country":               country,
		"report_date":           today.Format("2006-01-02"),
		"date_range":            dateRange,
		"project_context":       "",
		"sku_context":           "",
		"sku_factory_info_text": "",
	}

	curr7dQty := intValue(weekSales["week_qty"])
	prev7dQty := intValue(prevWeekSales["week_qty"])
	curr7dAmount := toFloat(weekSales["week_amount"])
	prev7dAmount := toFloat(prevWeekSales["week_amount"])
	period7dChange := 0.0
	if prev7dQty > 0 {
		period7dChange = float64(curr7dQty-prev7dQty) / float64(prev7dQty) * 100
	}
	period7dAmountChange := 0.0
	if prev7dAmount > 0 {
		period7dAmountChange = (curr7dAmount - prev7dAmount) / prev7dAmount * 100
	}

	return map[string]any{
		"project_name":               projectName,
		"country":                    country,
		"date_range":                 dateRange,
		"sales":                      sales,
		"week_sales":                 weekSales,
		"prev_week_sales":            prevWeekSales,
		"period7d_change_pct":        period7dChange,
		"period7d_amount_change_pct": period7dAmountChange,
		"period_start":               periodStart.Format("2006-01-02"),
		"period_end":                 today.Format("2006-01-02"),
		"prev_period_start":          prevPeriodStart.Format("2006-01-02"),
		"prev_period_end":            prevPeriodEnd.Format("2006-01-02"),
		"trend_days":                 trendDays,
		"top_skus":                   topSKUs,
		"sku_sales_detail":           skuSalesDetail,
		"inventory":                  inventory,
		"alert_rows":                 alertRows,
		"ads":                        ads,
		"returns":                    returns,
		"ai_summary":                 "",
		"report_date":                today.Format("2006-01-02"),
		"project_context":            "",
		"sku_context":                "",
		"sku_factory_info_text":      "",
		"ai_payload":                 reportData,
	}, nil
}

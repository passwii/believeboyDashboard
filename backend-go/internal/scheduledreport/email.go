package scheduledreport

import (
	_ "embed"
	"fmt"
	"html/template"
	"math"
	"strings"
)

//go:embed templates/daily_report.html
var dailyReportHTML string

type dailyEmailView struct {
	ProjectName  string
	CountryLabel string
	ReportDate   string
	FrequencyCn  string
	DateRange    string
	Currency     string
	SummaryHTML  template.HTML
	ShowSummary  bool
	YesterdayQty int
	YesterdayAmt float64
	PrevQty      int
	ChangePct    float64
	ChangeUp     bool
	WeekQty      int
	WeekAmount   float64
	Trend        []emailTrendDay
	SKUCount     int
	AvailableQty int
	InTransitQty int
	OOSCount     int
	LowCount     int
	AdSpend      float64
	AdRatio      float64
	AdROAS       float64
	AdACOS       float64
	AdCTR        float64
	ReturnQty    int
	ReturnRate   float64
	ReturnTop    []emailReturnReason
	TopSKUs      []emailTopSKU
	Alerts       []emailAlert
}

type emailTrendDay struct {
	Date   string
	Qty    int
	Height int
}

type emailReturnReason struct {
	Name string
	Qty  int
}

type emailTopSKU struct {
	SKU    string
	Qty    int
	Amount float64
}

type emailAlert struct {
	SKU string
	Qty int
}

var dailyEmailTemplate = template.Must(template.New("daily-report").Funcs(template.FuncMap{
	"currency": func(value float64, symbol string) string {
		return fmt.Sprintf("%s%s", symbol, formatThousands(value))
	},
	"pct": func(value float64) string {
		return fmt.Sprintf("%.1f%%", value)
	},
}).Parse(dailyReportHTML))

// RenderDailyReportHTML renders the report email HTML from BuildDailyReportData.
// It is a Go-native template equivalent of email_sender_daily, not a byte-for-byte port.
func RenderDailyReportHTML(data map[string]any, includeSummary bool) string {
	view := buildDailyEmailView(data)
	view.ShowSummary = includeSummary && strings.TrimSpace(string(view.SummaryHTML)) != ""
	var builder strings.Builder
	if err := dailyEmailTemplate.Execute(&builder, view); err != nil {
		return ""
	}
	return builder.String()
}

func buildDailyEmailView(data map[string]any) dailyEmailView {
	sales := mapValue(data, "sales")
	week := mapValue(data, "week_sales")
	inventory := mapValue(data, "inventory")
	ads := mapValue(data, "ads")
	returns := mapValue(data, "returns")
	country := stringValue(data, "country")
	if country == "" {
		country = "US"
	}
	view := dailyEmailView{
		ProjectName:  stringValue(data, "project_name"),
		CountryLabel: countryLabel(country),
		ReportDate:   stringValue(data, "report_date"),
		FrequencyCn:  frequencyLabel(stringValue(data, "frequency")),
		DateRange:    stringValue(data, "date_range"),
		Currency:     currencySymbol(country),
		SummaryHTML:  template.HTML(escapeHTML(stringValue(data, "ai_summary"))),
		YesterdayQty: intFrom(sales["yesterday_qty"]),
		YesterdayAmt: floatFrom(sales["yesterday_amount"]),
		PrevQty:      intFrom(sales["prev_qty"]),
		ChangePct:    floatFrom(sales["change_pct"]),
		ChangeUp:     floatFrom(sales["change_pct"]) >= 0,
		WeekQty:      intFrom(week["week_qty"]),
		WeekAmount:   floatFrom(week["week_amount"]),
		SKUCount:     intFrom(inventory["sku_count"]),
		AvailableQty: intFrom(inventory["total_available"]),
		InTransitQty: intFrom(inventory["in_transit"]),
		AdSpend:      floatFrom(ads["spend"]),
		AdRatio:      floatFrom(ads["ad_ratio_all"]),
		AdROAS:       floatFrom(ads["roas"]),
		AdACOS:       floatFrom(ads["acos"]),
		AdCTR:        floatFrom(ads["ctr"]),
		ReturnQty:    intFrom(returns["qty"]),
		ReturnRate:   floatFrom(returns["rate"]),
	}
	if view.ProjectName == "" {
		view.ProjectName = "项目"
	}
	view.OOSCount = len(mapSlice(inventory, "oos_skus"))
	view.LowCount = len(mapSlice(inventory, "low_stock_skus"))

	trend := mapSlice(data, "trend_days")
	maxQty := 1
	for _, day := range trend {
		if qty := intFrom(day["qty"]); qty > maxQty {
			maxQty = qty
		}
	}
	for _, day := range trend {
		qty := intFrom(day["qty"])
		height := int(math.Round(float64(qty) / float64(maxQty) * 60))
		if height < 4 {
			height = 4
		}
		view.Trend = append(view.Trend, emailTrendDay{Date: stringValue(day, "date"), Qty: qty, Height: height})
	}
	for _, item := range mapSlice(returns, "top_returns") {
		name := stringValue(item, "reason_display")
		if name == "" {
			name = stringValue(item, "reason")
		}
		view.ReturnTop = append(view.ReturnTop, emailReturnReason{Name: name, Qty: intFrom(item["qty"])})
	}
	for _, item := range mapSlice(data, "top_skus") {
		view.TopSKUs = append(view.TopSKUs, emailTopSKU{
			SKU: stringValue(item, "sku"), Qty: intFrom(item["qty"]), Amount: floatFrom(item["amount"]),
		})
	}
	for _, item := range mapSlice(data, "alert_rows") {
		view.Alerts = append(view.Alerts, emailAlert{SKU: stringValue(item, "sku"), Qty: intFrom(item["qty"])})
	}
	return view
}

func mapValue(source map[string]any, key string) map[string]any {
	if value, ok := source[key].(map[string]any); ok {
		return value
	}
	return map[string]any{}
}

func mapSlice(source map[string]any, key string) []map[string]any {
	if values, ok := source[key].([]map[string]any); ok {
		return values
	}
	if values, ok := source[key].([]any); ok {
		result := make([]map[string]any, 0, len(values))
		for _, value := range values {
			if item, ok := value.(map[string]any); ok {
				result = append(result, item)
			}
		}
		return result
	}
	return nil
}

func stringValue(source map[string]any, key string) string {
	if value, ok := source[key].(string); ok {
		return value
	}
	return ""
}

func intFrom(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	default:
		return 0
	}
}

func floatFrom(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	default:
		return 0
	}
}

func countryLabel(country string) string {
	names := map[string]string{
		"US": "美国", "UK": "英国", "GB": "英国", "DE": "德国", "FR": "法国",
		"IT": "意大利", "ES": "西班牙", "NL": "荷兰", "SE": "瑞典", "PL": "波兰",
		"BE": "比利时", "CA": "加拿大", "AU": "澳大利亚", "JP": "日本", "MX": "墨西哥", "EU": "欧洲",
	}
	name, ok := names[strings.ToUpper(country)]
	if !ok {
		name = strings.ToUpper(country)
	}
	return name + "站"
}

func currencySymbol(country string) string {
	switch strings.ToUpper(country) {
	case "DE":
		return "€"
	case "UK", "GB":
		return "£"
	default:
		return "$"
	}
}

func frequencyLabel(frequency string) string {
	switch frequency {
	case "weekly":
		return "每周"
	case "monthly":
		return "每月"
	default:
		return "每日"
	}
}

func formatThousands(value float64) string {
	negative := value < 0
	if negative {
		value = -value
	}
	formatted := fmt.Sprintf("%.2f", value)
	parts := strings.SplitN(formatted, ".", 2)
	integer := parts[0]
	for index := len(integer) - 3; index > 0; index -= 3 {
		integer = integer[:index] + "," + integer[index:]
	}
	result := integer + "." + parts[1]
	if negative {
		return "-" + result
	}
	return result
}

func escapeHTML(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\x22", "&quot;")
	return replacer.Replace(value)
}

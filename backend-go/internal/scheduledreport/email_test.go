package scheduledreport

import (
	"strings"
	"testing"
)

func sampleReportData() map[string]any {
	return map[string]any{
		"project_name": "示例项目",
		"country":      "US",
		"report_date":  "2026-11-11",
		"date_range":   "2026-11-05 ~ 2026-11-11",
		"ai_summary":   "运营摘要测试",
		"sales":        map[string]any{"yesterday_qty": 12, "yesterday_amount": 1234.5, "prev_qty": 10, "change_pct": 20.0},
		"week_sales":   map[string]any{"week_qty": 80, "week_amount": 9000.0},
		"trend_days": []map[string]any{
			{"date": "11-05", "qty": 10}, {"date": "11-06", "qty": 12},
		},
		"inventory": map[string]any{
			"sku_count": 3, "total_available": 15, "in_transit": 6,
			"oos_skus":       []map[string]any{{"sku": "SKU-1", "available_qty": 0}},
			"low_stock_skus": []map[string]any{{"sku": "SKU-2", "available_qty": 5}},
		},
		"ads": map[string]any{"spend": 25.0, "sales": 120.0, "roas": 4.8, "acos": 20.83, "ctr": 4.0, "ad_ratio_all": 2.03},
		"returns": map[string]any{
			"qty": 3, "rate": 2.27,
			"top_returns": []map[string]any{{"reason": "NOT_AS_DESCRIBED", "reason_display": "与描述不符", "qty": 2}},
		},
		"top_skus":   []map[string]any{{"sku": "SKU-1", "qty": 30, "amount": 1234.5}},
		"alert_rows": []map[string]any{{"sku": "SKU-1", "qty": 0}},
	}
}

func TestRenderDailyReportHTML(t *testing.T) {
	html := RenderDailyReportHTML(sampleReportData(), true)
	for _, expected := range []string{"示例项目", "美国站", "今日销量", "SKU-1", "与描述不符", "$1,234.50", "运营摘要测试"} {
		if !strings.Contains(html, expected) {
			t.Fatalf("rendered HTML missing %q", expected)
		}
	}
	withoutSummary := RenderDailyReportHTML(sampleReportData(), false)
	if strings.Contains(withoutSummary, "运营摘要测试") {
		t.Fatal("summary should be hidden when includeSummary=false")
	}
}

func TestRenderDailyReportHTMLSetsExplicitLeftAlignment(t *testing.T) {
	html := RenderDailyReportHTML(sampleReportData(), false)
	for _, expected := range []string{
		"background:#1F2937;padding:26px 24px;text-align:left;",
		"padding:20px 24px 8px;text-align:left;",
		"padding:16px 24px 4px;text-align:left;",
	} {
		if !strings.Contains(html, expected) {
			t.Fatalf("rendered HTML missing explicit alignment %q", expected)
		}
	}
}

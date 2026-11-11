package store

import (
	"context"
	"fmt"
	"html"
	"os"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/category_research"
	"github.com/passwii/believeboyDashboard/backend-go/internal/pdf"
)

func (s *CategoryResearchStore) buildCategorySummaryPDF(ctx context.Context, dataset category_research.CategoryResearchDatasetItem, overview category_research.CategoryResearchOverviewResponse) ([]byte, error) {
	html := buildCategorySummaryHTML(dataset, overview)
	return pdf.RenderHTMLToPDF(ctx, html, os.Getenv("CHROME_BIN"), 1240, 1754)
}

func buildCategorySummaryHTML(dataset category_research.CategoryResearchDatasetItem, overview category_research.CategoryResearchOverviewResponse) string {
	metrics := overview.AdvancedMetrics
	growth := metrics.MarketGrowth
	seasonality := metrics.Seasonality
	brand := metrics.BrandMonopoly
	seller := metrics.SellerMonopoly
	china := metrics.ChinaSellerComp
	newProduct := metrics.NewProductOpp
	quality := metrics.DataQuality

	var builder strings.Builder
	builder.WriteString("<html><head><meta charset=\x22utf-8\x22><style>")
	builder.WriteString("body{font-family:'Noto Sans SC',-apple-system,sans-serif;color:#111827;padding:32px;font-size:14px} h1{font-size:24px;margin:0 0 6px} h2{font-size:16px;margin:22px 0 8px;border-left:4px solid #2563EB;padding-left:10px} table{width:100%;border-collapse:collapse} td,th{padding:6px 8px;border-bottom:1px solid #E5E7EB;text-align:left} th{color:#6B7280;font-weight:600} .muted{color:#6B7280} .badge{background:#EFF6FF;color:#1D4ED8;padding:2px 8px;border-radius:4px;font-size:12px}")
	builder.WriteString("</style></head><body>")
	builder.WriteString(fmt.Sprintf("<h1>调研分析摘要</h1><div class=\x22muted\x22>%s · %s · V%d · 数据日期 %s</div>",
		html.EscapeString(dataset.CategoryNameZh), html.EscapeString(dataset.Marketplace), dataset.Version, valueOrDash(dataset.DataDate)))
	builder.WriteString(fmt.Sprintf("<p class=\x22muted\x22>关键词：%s<br/>样本产品：%d · 趋势样本：%d</p>",
		html.EscapeString(dataset.CategoryKeywordEn), dataset.RowCountProducts, dataset.RowCountTrends))

	builder.WriteString("<h2>一、核心指标</h2><table>")
	rows := [][2]string{
		{"样本数", fmt.Sprintf("%d", overview.Kpis.SampleCount)},
		{"品牌数", fmt.Sprintf("%d", overview.Kpis.BrandCount)},
		{"平均价格", fmt.Sprintf("$%.2f", overview.Kpis.AveragePriceUsd)},
		{"总月销量", fmt.Sprintf("%d", overview.Kpis.TotalMonthlySales)},
		{"Amazon 占比", fmt.Sprintf("%.1f%%", overview.Kpis.AmazonShare*100)},
	}
	for _, row := range rows {
		builder.WriteString(fmt.Sprintf("<tr><td>%s</td><td><strong>%s</strong></td></tr>", row[0], row[1]))
	}
	builder.WriteString("</table>")

	builder.WriteString("<h2>二、进入判断</h2><table>")
	rows = [][2]string{
		{"增长层级", fmt.Sprintf("%s · 最近 12M vs 前 12M %.1f%%", firstNonEmptyPDF(mapString(growth, "growth_tier"), mapString(growth, "growth_level"), "-"), mapFloat(growth, "last12_vs_prev12_growth")*100)},
		{"季节性层级", fmt.Sprintf("%s · 旺季前三月销量占比 %.1f%%", firstNonEmptyPDF(mapString(seasonality, "seasonality_tier"), mapString(seasonality, "seasonality_level"), "-"), mapFloat(seasonality, "peak3_month_sales_share")*100)},
		{"建议入场月", joinStrings(mapStringSlice(seasonality, "recommended_entry_months"))},
		{"新品机会", fmt.Sprintf("%s · 新品销量占比 %.1f%%", mapString(newProduct, "opportunity_level"), mapFloat(newProduct, "new_product_sales_share")*100)},
	}
	for _, row := range rows {
		builder.WriteString(fmt.Sprintf("<tr><td>%s</td><td><strong>%s</strong></td></tr>", row[0], row[1]))
	}
	builder.WriteString("</table>")

	builder.WriteString("<h2>三、竞争与风险</h2><table>")
	rows = [][2]string{
		{"品牌集中度", fmt.Sprintf("CR3 %.1f%% · 风险 %s", mapFloat(brand, "brand_cr3")*100, mapString(brand, "risk_level"))},
		{"卖家集中度", fmt.Sprintf("CR3 %.1f%% · 风险 %s", mapFloat(seller, "seller_cr3")*100, mapString(seller, "risk_level"))},
		{"中国卖家销量占比", fmt.Sprintf("%.1f%% · 风险 %s", mapFloat(china, "china_seller_sales_share")*100, mapString(china, "risk_level"))},
		{"数据质量", fmt.Sprintf("%.1f · %s", mapFloat(quality, "score"), mapString(quality, "summary"))},
	}
	for _, row := range rows {
		builder.WriteString(fmt.Sprintf("<tr><td>%s</td><td><strong>%s</strong></td></tr>", row[0], row[1]))
	}
	builder.WriteString("</table>")

	builder.WriteString("<h2>四、建议动作</h2>")
	actions := metrics.ActionRecs
	if len(actions) == 0 {
		builder.WriteString("<p>当前无自动建议动作，请结合市场节奏、品牌集中度和价格带机会手动判断。</p>")
	} else {
		builder.WriteString("<ol>")
		for index, raw := range actions {
			if index >= 5 {
				break
			}
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			builder.WriteString(fmt.Sprintf("<li><strong>[%s] %s</strong><br/><span class=\x22muted\x22>原因：%s<br/>先验证：%s</span></li>",
				mapString(item, "priority"), html.EscapeString(mapString(item, "action")),
				html.EscapeString(mapString(item, "why")), html.EscapeString(joinStrings(mapStringSlice(item, "required_validation")))))
		}
		builder.WriteString("</ol>")
	}

	builder.WriteString("<h2>五、补充说明</h2>")
	if len(metrics.PriceBandOpps) > 0 {
		builder.WriteString("<h3>机会价格带</h3><table>")
		for index, raw := range metrics.PriceBandOpps {
			if index >= 3 {
				break
			}
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			builder.WriteString(fmt.Sprintf("<tr><td>%s</td><td>月销量 %d</td><td>销量占比 %.1f%%</td></tr>",
				html.EscapeString(mapString(item, "label")), mapInt(item, "monthly_sales"), mapFloat(item, "sales_share")*100))
		}
		builder.WriteString("</table>")
	}
	if len(overview.BrandSalesShare) > 0 {
		builder.WriteString("<h3>头部品牌</h3><table>")
		for index, item := range overview.BrandSalesShare {
			if index >= 3 {
				break
			}
			builder.WriteString(fmt.Sprintf("<tr><td>%s</td><td>月销量 %d</td><td>占比 %.1f%%</td></tr>",
				html.EscapeString(item.Brand), item.MonthlySales, item.Share*100))
		}
		builder.WriteString("</table>")
	}
	builder.WriteString("</body></html>")
	return builder.String()
}

func mapString(source map[string]any, key string) string {
	if source == nil {
		return ""
	}
	if value, ok := source[key].(string); ok {
		return value
	}
	return ""
}

func mapFloat(source map[string]any, key string) float64 {
	if source == nil {
		return 0
	}
	switch value := source[key].(type) {
	case float64:
		return value
	case float32:
		return float64(value)
	case int:
		return float64(value)
	case int64:
		return float64(value)
	}
	return 0
}

func mapInt(source map[string]any, key string) int {
	return int(mapFloat(source, key))
}

func mapStringSlice(source map[string]any, key string) []string {
	if source == nil {
		return nil
	}
	raw, ok := source[key].([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if value, ok := item.(string); ok {
			result = append(result, value)
		}
	}
	return result
}

func valueOrDash(value *string) string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return "-"
	}
	return *value
}

func firstNonEmptyPDF(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return "-"
}

func joinStrings(values []string) string {
	if len(values) == 0 {
		return "-"
	}
	return strings.Join(values, "、")
}

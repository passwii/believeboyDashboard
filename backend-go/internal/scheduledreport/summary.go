package scheduledreport

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

// SummaryRequest asks the worker to generate an AI summary for a delivery log.
type SummaryRequest struct {
	LogID           int64
	OverrideAIModel *string
}

// GenerateDeliverySummary builds the report payload for a delivery log, asks the
// configured LLM for a short Chinese summary, and writes ai_summary_* fields.
// When AI is not configured it stores the deterministic fallback summary.
func GenerateDeliverySummary(ctx context.Context, db store.FullDB, provider ai.Provider, request SummaryRequest) (map[string]any, error) {
	if db == nil {
		return nil, fmt.Errorf("database is required")
	}
	var subscriptionID int64
	var frequency, reportDate, projectIDsText, country string
	var email *string
	err := db.QueryRow(ctx,
		"select l.subscription_id, l.frequency, l.report_date, l.email, s.project_ids, s.country "+
			"from public.scheduled_report_delivery_logs l "+
			"join public.scheduled_report_subscriptions s on s.id = l.subscription_id "+
			"where l.id = $1", request.LogID).
		Scan(&subscriptionID, &frequency, &reportDate, &email, &projectIDsText, &country)
	if err != nil {
		return nil, fmt.Errorf("load delivery log: %w", err)
	}
	projectIDs := parseProjectIDs(projectIDsText)
	reportDateValue, err := time.ParseInLocation("2006-01-02", reportDate, time.Local)
	if err != nil {
		return nil, fmt.Errorf("invalid report_date %q", reportDate)
	}
	referenceDate := reportDateValue
	if frequency == "daily" {
		referenceDate = reportDateValue.AddDate(0, 0, -1)
	}

	var reportData map[string]any
	if frequency == "monthly" {
		reportData, err = BuildMonthlyReportData(ctx, db, MonthlyOptions{
			ProjectIDs: projectIDs, Country: country, ReferenceDate: &referenceDate,
		})
	} else {
		reportData, err = BuildDailyReportData(ctx, db, DailyOptions{
			ProjectIDs: projectIDs, Country: country, Frequency: frequency, ReferenceDate: &referenceDate,
		})
	}
	if err != nil {
		return nil, fmt.Errorf("build report data: %w", err)
	}
	fallback := fallbackReportSummary(reportData)
	summary := fallback
	status := "done"
	modelName := ""
	if provider != nil && provider.Configured() {
		prompt := buildSummaryPrompt(reportData)
		response, _, completeErr := provider.Complete(ctx, ai.ChatRequest{
			Model: modelOrDefault(request.OverrideAIModel),
			Messages: []ai.Message{
				{Role: "system", Content: "你是跨境电商运营分析师。请用中文输出 3-5 条要点，总结报告中的销售、库存、广告与退货表现，并给出可执行建议。只输出正文，不要 Markdown 表格。"},
				{Role: "user", Content: prompt},
			},
			Temperature: 0.3,
		})
		if completeErr != nil {
			status = "failed"
			_, _ = db.Exec(ctx,
				"update public.scheduled_report_delivery_logs set ai_summary_status = 'failed', ai_summary_error = $2, ai_summary_updated_at = now() where id = $1",
				request.LogID, completeErr.Error())
			return nil, fmt.Errorf("generate ai summary: %w", completeErr)
		}
		if strings.TrimSpace(response) != "" {
			summary = strings.TrimSpace(response)
			modelName = resolveModelName(request.OverrideAIModel)
		}
	}
	if summary == "" {
		summary = fallback
	}
	_, err = db.Exec(ctx,
		"update public.scheduled_report_delivery_logs set ai_summary = $2, ai_summary_status = 'done', ai_summary_model = nullif($3, ''), ai_summary_error = null, ai_summary_updated_at = now() where id = $1",
		request.LogID, summary, modelName)
	if err != nil {
		return nil, fmt.Errorf("write ai summary: %w", err)
	}
	return map[string]any{
		"log_id": request.LogID, "status": status, "ai_summary": summary, "model": modelName,
	}, nil
}

func parseProjectIDs(raw string) []int64 {
	if strings.TrimSpace(raw) == "" || strings.TrimSpace(raw) == "*" {
		return nil
	}
	var ids []int64
	for _, part := range strings.Split(raw, ",") {
		var id int64
		if _, err := fmt.Sscanf(strings.TrimSpace(part), "%d", &id); err == nil && id > 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

func fallbackReportSummary(reportData map[string]any) string {
	sales := mapValue(reportData, "sales")
	week := mapValue(reportData, "week_sales")
	inventory := mapValue(reportData, "inventory")
	ads := mapValue(reportData, "ads")
	returns := mapValue(reportData, "returns")
	country := stringValue(reportData, "country")
	return fmt.Sprintf(
		"◉ %s\n销量%d单，销售额%s；统计周期累计%d单，销售额%s。\n库存可用%d件，在途%d件；广告花费%s，ROAS %.2f；退货%d件，退货率%.1f%%。",
		countryLabel(country),
		intFrom(sales["yesterday_qty"]), formatCurrency(intFrom(sales["yesterday_qty"]), sales["yesterday_amount"], country),
		intFrom(week["week_qty"]), formatCurrency(intFrom(week["week_qty"]), week["week_amount"], country),
		intFrom(inventory["total_available"]), intFrom(inventory["in_transit"]),
		formatCurrency(0, ads["spend"], country), floatFrom(ads["roas"]),
		intFrom(returns["qty"]), floatFrom(returns["rate"]),
	)
}

func formatCurrency(_ int, value any, country string) string {
	return fmt.Sprintf("%s%s", currencySymbol(country), formatThousands(floatFrom(value)))
}

func buildSummaryPrompt(reportData map[string]any) string {
	payload := map[string]any{
		"project_name": stringValue(reportData, "project_name"),
		"country":      stringValue(reportData, "country"),
		"report_date":  stringValue(reportData, "report_date"),
		"date_range":   stringValue(reportData, "date_range"),
		"sales":        mapValue(reportData, "sales"),
		"week_sales":   mapValue(reportData, "week_sales"),
		"inventory":    mapValue(reportData, "inventory"),
		"ads":          mapValue(reportData, "ads"),
		"returns":      mapValue(reportData, "returns"),
		"top_skus":     mapSlice(reportData, "top_skus"),
	}
	encoded, _ := json.Marshal(payload)
	return "请基于以下报告数据生成运营摘要：\n" + string(encoded)
}

func resolveModelName(override *string) string {
	if override != nil && strings.TrimSpace(*override) != "" {
		return strings.TrimSpace(*override)
	}
	return ""
}

func modelOrDefault(model *string) string {
	if model != nil {
		return strings.TrimSpace(*model)
	}
	return ""
}

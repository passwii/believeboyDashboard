package ai_chat_usage

import (
	"net/http"
	"sort"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

var cst = time.FixedZone("Asia/Shanghai", 8*60*60)

type Handler struct {
	store Store
	now   func() time.Time
}

func NewHandler(store Store) *Handler {
	return NewHandlerWithClock(store, time.Now)
}

func NewHandlerWithClock(store Store, now func() time.Time) *Handler {
	if now == nil {
		now = time.Now
	}
	return &Handler{store: store, now: now}
}

func (handler *Handler) GetStats(w http.ResponseWriter, r *http.Request) {
	rawRange := "30d"
	if values, present := r.URL.Query()["range"]; present && len(values) > 0 {
		rawRange = values[len(values)-1]
	}
	usageRange := UsageRange(rawRange)
	days, ok := usageRangeDays[usageRange]
	if !ok {
		httpapi.WriteValidationErrors(w, []httpapi.ValidationError{{
			Type:  "literal_error",
			Loc:   []string{"query", "range"},
			Msg:   "Input should be '7d', '30d' or '90d'",
			Input: rawRange,
		}})
		return
	}
	today := handler.now().In(cst)
	endDate := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)
	startDate := endDate.AddDate(0, 0, -(days - 1))

	freshness, err := handler.store.Freshness(r.Context())
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	userID := ai_chat.RequestUserID(r)
	if userID == nil || freshness.LatestDataDate == nil {
		_ = httpapi.WriteJSON(w, http.StatusOK, emptyStats(usageRange, startDate, endDate, freshness))
		return
	}
	rows, err := handler.store.ListSnapshots(r.Context(), *userID, startDate, endDate)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	type counters struct {
		prompt        int
		completion    int
		total         int
		messages      int
		conversations int
	}
	byDate := make(map[string]*counters)
	byModel := make(map[string]*counters)
	totals := UsageTotals{}
	for _, row := range rows {
		dateKey := row.DataDate.Format("2006-01-02")
		day := byDate[dateKey]
		if day == nil {
			day = &counters{}
			byDate[dateKey] = day
		}
		day.prompt += row.PromptTokens
		day.completion += row.CompletionTokens
		day.total += row.TotalTokens
		day.messages += row.MessageCount

		model := byModel[row.Model]
		if model == nil {
			model = &counters{}
			byModel[row.Model] = model
		}
		model.prompt += row.PromptTokens
		model.completion += row.CompletionTokens
		model.total += row.TotalTokens
		model.messages += row.MessageCount

		totals.PromptTokens += row.PromptTokens
		totals.CompletionTokens += row.CompletionTokens
		totals.TotalTokens += row.TotalTokens
		totals.MessageCount += row.MessageCount
		totals.ConversationCount += row.ConversationCount
	}

	daily := make([]DailyPoint, 0, days)
	for cursor := startDate; !cursor.After(endDate); cursor = cursor.AddDate(0, 0, 1) {
		day := byDate[cursor.Format("2006-01-02")]
		point := DailyPoint{Date: cursor.Format("2006-01-02")}
		if day != nil {
			point.PromptTokens = day.prompt
			point.CompletionTokens = day.completion
			point.TotalTokens = day.total
			point.MessageCount = day.messages
		}
		daily = append(daily, point)
	}
	models := make([]UsageModelSummary, 0, len(byModel))
	for name, values := range byModel {
		models = append(models, UsageModelSummary{
			Model:            name,
			PromptTokens:     values.prompt,
			CompletionTokens: values.completion,
			TotalTokens:      values.total,
			MessageCount:     values.messages,
		})
	}
	sort.Slice(models, func(left, right int) bool {
		if models[left].TotalTokens != models[right].TotalTokens {
			return models[left].TotalTokens > models[right].TotalTokens
		}
		return models[left].Model < models[right].Model
	})

	_ = httpapi.WriteJSON(w, http.StatusOK, StatsResponse{
		Range:             usageRange,
		StartDate:         startDate.Format("2006-01-02"),
		EndDate:           endDate.Format("2006-01-02"),
		Totals:            totals,
		Daily:             daily,
		ByModel:           models,
		SnapshotFreshness: serializeFreshness(freshness),
	})
}

func emptyStats(
	usageRange UsageRange,
	startDate time.Time,
	endDate time.Time,
	freshness Freshness,
) StatsResponse {
	daily := make([]DailyPoint, 0)
	for cursor := startDate; !cursor.After(endDate); cursor = cursor.AddDate(0, 0, 1) {
		daily = append(daily, DailyPoint{Date: cursor.Format("2006-01-02")})
	}
	return StatsResponse{
		Range:             usageRange,
		StartDate:         startDate.Format("2006-01-02"),
		EndDate:           endDate.Format("2006-01-02"),
		Totals:            UsageTotals{},
		Daily:             daily,
		ByModel:           []UsageModelSummary{},
		SnapshotFreshness: serializeFreshness(freshness),
	}
}

func serializeFreshness(value Freshness) SnapshotFreshness {
	result := SnapshotFreshness{}
	if value.LatestDataDate != nil {
		formatted := value.LatestDataDate.Format("2006-01-02")
		result.LatestDataDate = &formatted
	}
	result.LatestComputedAt = httpapi.OptionalTimestamp(value.LatestComputedAt)
	return result
}

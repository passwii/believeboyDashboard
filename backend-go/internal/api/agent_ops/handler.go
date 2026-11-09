package agent_ops

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Store interface {
	DomainSummary(context.Context, time.Time, time.Time) ([]DomainSummaryItem, error)
	EmployeeSummary(context.Context, time.Time, time.Time) ([]EmployeeSummaryItem, error)
}

type Handler struct {
	store Store
	now   func() time.Time
}

func NewHandler(store Store, now func() time.Time) *Handler {
	if now == nil {
		now = time.Now
	}
	return &Handler{store: store, now: now}
}

func (handler *Handler) DomainSummary(w http.ResponseWriter, r *http.Request) {
	now, days, ok := parseSummaryWindow(w, r, handler.now)
	if !ok {
		return
	}
	items, err := handler.store.DomainSummary(
		r.Context(),
		now.AddDate(0, 0, -days),
		now.Add(-24*time.Hour),
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	responseItems := make([]domainSummaryJSONItem, 0, len(items))
	for _, item := range items {
		responseItems = append(responseItems, domainSummaryJSONItem{
			Domain:       item.Domain,
			Calls24h:     item.Calls24h,
			Calls7d:      item.Calls7d,
			Writes24h:    item.Writes24h,
			Writes7d:     item.Writes7d,
			Errors7d:     item.Errors7d,
			LastActiveAt: httpapi.OptionalTimestamp(item.LastActiveAt),
		})
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, domainSummaryJSONResponse{
		GeneratedAt: httpapi.Timestamp(now),
		WindowDays:  days,
		Items:       responseItems,
	})
}

func (handler *Handler) EmployeeSummary(w http.ResponseWriter, r *http.Request) {
	now, days, ok := parseSummaryWindow(w, r, handler.now)
	if !ok {
		return
	}
	items, err := handler.store.EmployeeSummary(
		r.Context(),
		now.AddDate(0, 0, -days),
		now.Add(-24*time.Hour),
	)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	responseItems := make([]employeeSummaryJSONItem, 0, len(items))
	for _, item := range items {
		responseItems = append(responseItems, employeeSummaryJSONItem{
			APIKeyID:     item.APIKeyID,
			Calls24h:     item.Calls24h,
			Calls7d:      item.Calls7d,
			Writes24h:    item.Writes24h,
			Writes7d:     item.Writes7d,
			Errors7d:     item.Errors7d,
			LastActiveAt: httpapi.OptionalTimestamp(item.LastActiveAt),
		})
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, employeeSummaryJSONResponse{
		GeneratedAt: httpapi.Timestamp(now),
		WindowDays:  days,
		Items:       responseItems,
	})
}

func parseSummaryWindow(w http.ResponseWriter, r *http.Request, now func() time.Time) (time.Time, int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("days"))
	days := 7
	if raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > MaxWindowDays {
			httpapi.WriteDetail(w, http.StatusBadRequest, fmt.Sprintf("days must be between 1 and %d", MaxWindowDays))
			return time.Time{}, 0, false
		}
		days = parsed
	}
	return now().UTC(), days, true
}

type domainSummaryJSONItem struct {
	Domain       string  `json:"domain"`
	Calls24h     int64   `json:"calls_24h"`
	Calls7d      int64   `json:"calls_7d"`
	Writes24h    int64   `json:"writes_24h"`
	Writes7d     int64   `json:"writes_7d"`
	Errors7d     int64   `json:"errors_7d"`
	LastActiveAt *string `json:"last_active_at"`
}

type domainSummaryJSONResponse struct {
	GeneratedAt string                  `json:"generated_at"`
	WindowDays  int                     `json:"window_days"`
	Items       []domainSummaryJSONItem `json:"items"`
}

type employeeSummaryJSONItem struct {
	APIKeyID     int64   `json:"api_key_id"`
	Calls24h     int64   `json:"calls_24h"`
	Calls7d      int64   `json:"calls_7d"`
	Writes24h    int64   `json:"writes_24h"`
	Writes7d     int64   `json:"writes_7d"`
	Errors7d     int64   `json:"errors_7d"`
	LastActiveAt *string `json:"last_active_at"`
}

type employeeSummaryJSONResponse struct {
	GeneratedAt string                    `json:"generated_at"`
	WindowDays  int                       `json:"window_days"`
	Items       []employeeSummaryJSONItem `json:"items"`
}

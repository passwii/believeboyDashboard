package ai_chat_usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestAIChatUsageRegistrarRegistersStatsRoute(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar(&fakeUsageStore{}).RegisterRoutes(router, func(next http.Handler) http.Handler { return next })
	registered := false
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if method == http.MethodGet && route == "/api/v1/ai/usage/stats" {
			registered = true
		}
		return nil
	}); err != nil {
		t.Fatalf("Walk() error = %v", err)
	}
	if !registered {
		t.Fatal("AI usage stats route was not registered")
	}
}

func TestAIChatUsageMissingIdentityReturnsZeroFilledThirtyDays(t *testing.T) {
	latest := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	computed := time.Date(2026, 11, 8, 3, 15, 0, 0, time.UTC)
	store := &fakeUsageStore{freshness: Freshness{
		LatestDataDate:   &latest,
		LatestComputedAt: &computed,
	}}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/ai/usage/stats", nil)
	NewHandlerWithClock(store, func() time.Time {
		return time.Date(2026, 11, 7, 12, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	}).GetStats(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Range  string         `json:"range"`
		Totals map[string]int `json:"totals"`
		Daily  []struct {
			Date        string `json:"date"`
			TotalTokens int    `json:"total_tokens"`
		} `json:"daily"`
		ByModel           []any `json:"by_model"`
		SnapshotFreshness struct {
			LatestDataDate   string `json:"latest_data_date"`
			LatestComputedAt string `json:"latest_computed_at"`
		} `json:"snapshot_freshness"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Range != "30d" || len(response.Daily) != 30 || len(response.ByModel) != 0 {
		t.Errorf("response = %#v", response)
	}
	if response.Daily[len(response.Daily)-1].Date != "2026-11-07" {
		t.Errorf("last date = %s", response.Daily[len(response.Daily)-1].Date)
	}
	if response.SnapshotFreshness.LatestDataDate != "2026-11-07" ||
		response.SnapshotFreshness.LatestComputedAt != "2026-11-08T03:15:00Z" {
		t.Errorf("freshness = %#v", response.SnapshotFreshness)
	}
	if store.listCalls != 0 {
		t.Errorf("ListSnapshots calls = %d, want 0", store.listCalls)
	}
}

func TestAIChatUsageAggregatesDailyTotalsAndModels(t *testing.T) {
	latest := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	store := &fakeUsageStore{
		freshness: Freshness{LatestDataDate: &latest},
		rows: []SnapshotRow{
			{
				DataDate: time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
				Model:    "model-a", PromptTokens: 10, CompletionTokens: 20,
				TotalTokens: 30, MessageCount: 2, ConversationCount: 1,
			},
			{
				DataDate: time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC),
				Model:    "model-b", PromptTokens: 1, CompletionTokens: 2,
				TotalTokens: 3, MessageCount: 1, ConversationCount: 1,
			},
		},
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/ai/usage/stats?range=7d", nil)
	request = request.WithContext(auth.WithUserContext(context.Background(), auth.UserContext{UserID: "42"}))
	recorder := httptest.NewRecorder()
	NewHandler(store).GetStats(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Totals  UsageTotals         `json:"totals"`
		ByModel []UsageModelSummary `json:"by_model"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Totals != (UsageTotals{
		PromptTokens: 11, CompletionTokens: 22, TotalTokens: 33,
		MessageCount: 3, ConversationCount: 2,
	}) {
		t.Errorf("totals = %#v", response.Totals)
	}
	if len(response.ByModel) != 2 || response.ByModel[0].Model != "model-a" ||
		response.ByModel[0].TotalTokens != 30 {
		t.Errorf("by_model = %#v", response.ByModel)
	}
	if store.userID == nil || *store.userID != 42 {
		t.Errorf("store user id = %#v", store.userID)
	}
}

func TestAIChatUsageRejectsUnknownRangeWithFastAPI422Shape(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/ai/usage/stats?range=14d", nil)
	NewHandler(&fakeUsageStore{}).GetStats(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

type fakeUsageStore struct {
	rows      []SnapshotRow
	freshness Freshness
	err       error
	freshErr  error
	userID    *int64
	listCalls int
	startDate time.Time
	endDate   time.Time
}

func (store *fakeUsageStore) ListSnapshots(
	_ context.Context,
	userID int64,
	startDate time.Time,
	endDate time.Time,
) ([]SnapshotRow, error) {
	store.listCalls++
	store.userID = &userID
	store.startDate = startDate
	store.endDate = endDate
	return store.rows, store.err
}

func (store *fakeUsageStore) Freshness(context.Context) (Freshness, error) {
	return store.freshness, store.freshErr
}

var _ Store = (*fakeUsageStore)(nil)

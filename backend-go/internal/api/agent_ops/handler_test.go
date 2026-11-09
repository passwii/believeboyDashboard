package agent_ops

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDomainSummaryReturnsRealAggregates(t *testing.T) {
	last := time.Date(2026, 11, 8, 7, 6, 5, 123456000, time.UTC)
	store := &handlerStore{
		domains: []DomainSummaryItem{{
			Domain: "orders", Calls24h: 3, Calls7d: 9, Writes24h: 1,
			Writes7d: 2, Errors7d: 1, LastActiveAt: &last,
		}},
	}
	handler := NewHandler(store, func() time.Time { return last })
	rec := httptest.NewRecorder()
	handler.DomainSummary(rec, httptest.NewRequest(http.MethodGet, "/api/v1/agent-ops/domain-summary?days=7", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	items := got["items"].([]any)
	item := items[0].(map[string]any)
	if item["domain"] != "orders" || item["calls_7d"].(float64) != 9 ||
		item["last_active_at"] != "2026-11-08T07:06:05.123456Z" {
		t.Fatalf("item = %#v", item)
	}
}

func TestDomainSummaryRejectsInvalidWindow(t *testing.T) {
	handler := NewHandler(&handlerStore{}, time.Now)
	rec := httptest.NewRecorder()
	handler.DomainSummary(rec, httptest.NewRequest(http.MethodGet, "/api/v1/agent-ops/domain-summary?days=91", nil))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"detail"`) {
		t.Fatalf("response = %d %s", rec.Code, rec.Body.String())
	}
}

type handlerStore struct {
	domains   []DomainSummaryItem
	employees []EmployeeSummaryItem
	err       error
}

func (s *handlerStore) DomainSummary(context.Context, time.Time, time.Time) ([]DomainSummaryItem, error) {
	return s.domains, s.err
}

func (s *handlerStore) EmployeeSummary(context.Context, time.Time, time.Time) ([]EmployeeSummaryItem, error) {
	return s.employees, s.err
}

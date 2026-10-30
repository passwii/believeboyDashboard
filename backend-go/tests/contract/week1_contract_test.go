package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

// These are fast handler-level contract fixtures. They intentionally do not
// require FastAPI, Redis, or PostgreSQL. The required live FastAPI/Go semantic
// diff runs in live_contract_test.go when LIVE_CONTRACT_REQUIRED=1 or in CI.
func TestWeek1ContractHealthNormalAndEmptyDependencies(t *testing.T) {
	normal := health.NewHandler(health.HandlerConfig{
		Database:   contractPinger{},
		Replica:    contractProbe("ok (lag=0.2s)"),
		Redis:      contractRedisProbe{status: "ok (1.0ms)", memory: ptr("2.00M")},
		Version:    "test",
		ReplicaURL: "postgres://replica",
		Now:        fixedNow,
	})
	assertContractJSON(t, normal.Health, "/api/v1/health", http.StatusOK, map[string]any{
		"status":           "ok",
		"timestamp":        float64(1793062800),
		"database":         "ok",
		"database_replica": "ok (lag=0.2s)",
		"redis":            "ok (1.0ms)",
		"redis_memory":     "2.00M",
		"version":          "test",
	})

	empty := health.NewHandler(health.HandlerConfig{
		Database: contractPinger{},
		Now:      fixedNow,
	})
	assertContractJSON(t, empty.Health, "/api/v1/health", http.StatusOK, map[string]any{
		"status":           "ok",
		"timestamp":        float64(1793062800),
		"database":         "ok",
		"database_replica": "not configured",
		"redis":            "not configured",
		"redis_memory":     nil,
		"version":          nil,
	})

	assertContractJSON(t, empty.HealthLive, "/api/v1/health/live", http.StatusOK, map[string]any{
		"status":    "ok",
		"timestamp": float64(1793062800),
	})
	assertContractJSON(t, empty.HealthReady, "/api/v1/health/ready", http.StatusOK, map[string]any{
		"status":    "ok",
		"timestamp": float64(1793062800),
	})
}

func TestWeek1ContractExchangeRatesNormalAndEmpty(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 1, 2, 3, 456789000, time.UTC)
	store := &contractExchangeStore{
		listRows: []exchange_rates.ExchangeRate{{
			ID:           1,
			Currency:     "USD",
			CurrencyName: ptr("美元"),
			YearMonth:    "2026-10",
			Rate:         7.1,
			NoteImages:   []map[string]any{},
			CreatedAt:    createdAt,
			UpdatedAt:    createdAt,
		}},
		listTotal: 1,
		resolveRow: &exchange_rates.ExchangeRate{
			ID:        1,
			Currency:  "USD",
			YearMonth: "2026-10",
			Rate:      7.1,
		},
		optionRows: []exchange_rates.ExchangeRate{{
			Currency:     "USD",
			CurrencyName: ptr("美元"),
			YearMonth:    "2026-10",
		}},
		getRow: &exchange_rates.ExchangeRate{
			ID:        1,
			Currency:  "USD",
			YearMonth: "2026-10",
			Rate:      7.1,
			CreatedAt: createdAt,
			UpdatedAt: createdAt,
		},
	}
	handler := exchange_rates.NewHandler(store)

	list := requestContract(handler.ListExchangeRates, "/api/v1/exchange-rates")
	assertStatusAndKeys(t, list, http.StatusOK, []string{"items", "total", "page", "page_size"})

	resolve := requestContract(handler.ResolveExchangeRate, "/api/v1/exchange-rates/resolve?currency=USD&year_month=2026-10")
	assertStatusAndKeys(t, resolve, http.StatusOK, []string{"currency", "year_month", "rate", "description", "note_images", "source"})

	options := requestContract(handler.ExchangeRateOptions, "/api/v1/exchange-rates/options")
	assertStatusAndKeys(t, options, http.StatusOK, []string{"currencies", "years", "months"})

	item := requestContractWithParam(handler.GetExchangeRate, "/api/v1/exchange-rates/1", "exchange_rate_id", "1")
	assertStatusAndKeys(t, item, http.StatusOK, []string{
		"id", "currency", "currency_name", "year_month", "rate", "description",
		"note_images", "created_at", "updated_at",
	})

	emptyStore := &contractExchangeStore{}
	emptyHandler := exchange_rates.NewHandler(emptyStore)
	emptyList := requestContract(emptyHandler.ListExchangeRates, "/api/v1/exchange-rates")
	assertStatusAndBody(t, emptyList, http.StatusOK, `{"items":[],"total":0,"page":1,"page_size":50}`)
	emptyResolve := requestContract(emptyHandler.ResolveExchangeRate, "/api/v1/exchange-rates/resolve?currency=USD&year_month=2026-10")
	assertStatusAndKeys(t, emptyResolve, http.StatusOK, []string{"currency", "year_month", "rate", "description", "note_images", "source"})
	emptyGet := requestContractWithParam(emptyHandler.GetExchangeRate, "/api/v1/exchange-rates/999", "exchange_rate_id", "999")
	assertStatusAndBody(t, emptyGet, http.StatusNotFound, `{"detail":"Exchange rate not found"}`)
}

func TestWeek1ContractProfileNormalAndNotFound(t *testing.T) {
	store := &contractProfileStore{row: &profile.Profile{
		ID:       "user-123",
		Email:    "user@example.com",
		Name:     "user",
		IsActive: true,
		RoleType: "operator",
	}}
	handler := profile.NewHandler(store)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	request.Header.Set("X-User-Id", "user-123")
	recorder := httptest.NewRecorder()
	handler.GetProfile(recorder, withRequestIdentity(request))
	assertStatusAndKeys(t, recorder, http.StatusOK, []string{
		"id", "email", "name", "full_name", "is_admin", "is_active", "role_type",
		"avatar_url", "password_changed_at", "created_at", "updated_at",
	})

	notFound := profile.NewHandler(&contractProfileStore{})
	request = httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	request.Header.Set("X-User-Id", "missing")
	recorder = httptest.NewRecorder()
	notFound.GetProfile(recorder, withRequestIdentity(request))
	assertStatusAndBody(t, recorder, http.StatusNotFound, `{"detail":"User not found"}`)
}

func TestWeek1ContractNotificationsNormalAndEmpty(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	store := &contractNotificationStore{rows: []notifications.Notification{{
		ID:        1,
		UserID:    10,
		Type:      "alert",
		Title:     "title",
		Data:      json.RawMessage(`{"project_id":3}`),
		Read:      true,
		CreatedAt: createdAt,
	}}, total: 1}
	handler := notifications.NewHandler(store)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	request.Header.Set("X-User-Id", "1_0")
	recorder := httptest.NewRecorder()
	handler.List(recorder, withRequestIdentity(request))
	assertStatusAndBody(t, recorder, http.StatusOK, `{"items":[{"id":1,"user_id":10,"type":"alert","title":"title","message":null,"data":{"project_id":3},"read":true,"read_at":null,"created_at":"2026-10-01T02:03:04.123000Z"}],"total":1,"page":1,"page_size":20}`)

	empty := notifications.NewHandler(&contractNotificationStore{})
	request = httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	request.Header.Set("X-User-Id", "10")
	recorder = httptest.NewRecorder()
	empty.List(recorder, withRequestIdentity(request))
	assertStatusAndBody(t, recorder, http.StatusOK, `{"items":[],"total":0,"page":1,"page_size":20}`)

	request = httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	recorder = httptest.NewRecorder()
	empty.List(recorder, withRequestIdentity(request))
	assertStatusAndBody(t, recorder, http.StatusUnauthorized, `{"detail":"X-User-Id required"}`)

	request = httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
	request.Header.Set("X-User-Id", "invalid")
	recorder = httptest.NewRecorder()
	empty.List(recorder, withRequestIdentity(request))
	assertStatusAndBody(t, recorder, http.StatusBadRequest, `{"detail":"Invalid X-User-Id"}`)

	request = httptest.NewRequest(http.MethodGet, "/api/v1/notifications/unread-count", nil)
	request.Header.Set("X-User-Id", "10")
	recorder = httptest.NewRecorder()
	empty.UnreadCount(recorder, withRequestIdentity(request))
	assertStatusAndBody(t, recorder, http.StatusOK, `{"count":0}`)
}

func TestWeek1ContractAlertsNormalAndEmpty(t *testing.T) {
	createdAt := time.Date(2026, 10, 1, 2, 3, 4, 123000000, time.UTC)
	store := &contractAlertStore{
		project: &alerts.Project{ProjectOperator: ptr("operator-a")},
		ruleRows: []alerts.Rule{{
			ID:                   1,
			Name:                 "rule",
			ProjectID:            2,
			Country:              "US",
			Metric:               "acos",
			TriggerType:          "threshold",
			Condition:            "above",
			Threshold:            0.25,
			WindowDays:           7,
			Severity:             "warning",
			NotificationChannels: "in_app",
			IsActive:             true,
			CreatedBy:            "operator-a",
			CreatedAt:            createdAt,
			UpdatedAt:            createdAt,
		}},
		eventRows: []alerts.Event{{
			ID:            1,
			RuleID:        1,
			ProjectID:     2,
			Metric:        "acos",
			CurrentValue:  0.3,
			BaselineValue: 0.2,
			DeviationPct:  50,
			Severity:      "warning",
			Message:       "message",
			Status:        "active",
			TriggeredAt:   createdAt,
		}},
		eventTotal: 1,
	}
	handler := alerts.NewHandler(store)

	metrics := requestContract(handler.Metrics, "/api/v1/alerts/metrics")
	assertStatusAndBody(t, metrics, http.StatusOK, `{"metrics":[{"value":"sales_amount","label":"销售额","description":"每日销售总额"},{"value":"order_qty","label":"订单量","description":"每日订单总数"},{"value":"ad_spend","label":"广告花费","description":"每日广告总支出"},{"value":"acos","label":"ACOS","description":"广告销售成本比"},{"value":"return_rate","label":"退货率","description":"退货占总订单比例"},{"value":"inventory_risk","label":"库存风险","description":"库存缺货风险等级"},{"value":"reconciliation_mismatch","label":"报表核对异常","description":"PDF与数据库数据匹配率低于阈值"}]}`)

	rulesRequest := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules", nil)
	rulesRequest.Header.Set("X-Operator", "operator-a")
	rules := requestWithHeaders(handler.Rules, rulesRequest)
	if rules.Code != http.StatusOK {
		t.Fatalf("rules status = %d, want 200; body = %s", rules.Code, rules.Body.String())
	}
	if !strings.Contains(rules.Body.String(), `"created_at":"2026-10-01T02:03:04.123000Z"`) {
		t.Errorf("rules body = %s, want FastAPI timestamp", rules.Body.String())
	}

	eventsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/events", nil)
	eventsRequest.Header.Set("X-Operator", "operator-a")
	events := requestWithHeaders(handler.Events, eventsRequest)
	assertStatusAndKeys(t, events, http.StatusOK, []string{"items", "total", "page", "page_size"})
	if !strings.Contains(events.Body.String(), `"triggered_at":"2026-10-01T02:03:04.123000Z"`) {
		t.Errorf("events body = %s, want FastAPI timestamp", events.Body.String())
	}

	statsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/stats", nil)
	statsRequest.Header.Set("X-Operator", "operator-a")
	statsRequest.Header.Set("X-Is-Admin", "false")
	stats := requestWithHeaders(handler.Stats, statsRequest)
	assertStatusAndBody(t, stats, http.StatusOK, `{"total_active":0,"critical_count":0,"warning_count":0,"info_count":0,"acknowledged_today":0,"resolved_today":0}`)

	empty := alerts.NewHandler(&contractAlertStore{})
	emptyRulesRequest := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules", nil)
	emptyRules := requestWithHeaders(empty.Rules, emptyRulesRequest)
	assertStatusAndBody(t, emptyRules, http.StatusOK, `[]`)
	emptyEventsRequest := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/events", nil)
	emptyEvents := requestWithHeaders(empty.Events, emptyEventsRequest)
	assertStatusAndBody(t, emptyEvents, http.StatusOK, `{"items":[],"total":0,"page":1,"page_size":20}`)
}

type contractPinger struct{}

func (contractPinger) Ping(context.Context) error { return nil }

type contractProbe string

func (p contractProbe) Probe(context.Context) string { return string(p) }

type contractRedisProbe struct {
	status string
	memory *string
}

func (p contractRedisProbe) Probe(context.Context) (string, *string) {
	return p.status, p.memory
}

type contractExchangeStore struct {
	listRows   []exchange_rates.ExchangeRate
	listTotal  int
	resolveRow *exchange_rates.ExchangeRate
	optionRows []exchange_rates.ExchangeRate
	getRow     *exchange_rates.ExchangeRate
}

func (s *contractExchangeStore) List(context.Context, *string, *string, int, int) ([]exchange_rates.ExchangeRate, int, error) {
	return s.listRows, s.listTotal, nil
}

func (s *contractExchangeStore) Resolve(context.Context, string, string) (*exchange_rates.ExchangeRate, error) {
	return s.resolveRow, nil
}

func (s *contractExchangeStore) ListOptionRows(context.Context) ([]exchange_rates.ExchangeRate, error) {
	return s.optionRows, nil
}

func (s *contractExchangeStore) Get(context.Context, int64) (*exchange_rates.ExchangeRate, error) {
	return s.getRow, nil
}

type contractProfileStore struct {
	row *profile.Profile
}

func (s *contractProfileStore) GetByUserID(context.Context, string) (*profile.Profile, error) {
	return s.row, nil
}

type contractNotificationStore struct {
	rows  []notifications.Notification
	total int
}

func (s *contractNotificationStore) List(
	context.Context,
	string,
	notifications.ListParams,
) ([]notifications.Notification, int, error) {
	return s.rows, s.total, nil
}

func (s *contractNotificationStore) UnreadCount(context.Context, string) (int, error) {
	return 0, nil
}

type contractAlertStore struct {
	project    *alerts.Project
	ruleRows   []alerts.Rule
	eventRows  []alerts.Event
	eventTotal int
}

func (s *contractAlertStore) GetProject(context.Context, string) (*alerts.Project, error) {
	return s.project, nil
}

func (s *contractAlertStore) ListRules(context.Context, alerts.RuleFilters) ([]alerts.Rule, error) {
	return s.ruleRows, nil
}

func (s *contractAlertStore) ListEvents(
	context.Context,
	alerts.EventFilters,
) ([]alerts.Event, int, error) {
	return s.eventRows, s.eventTotal, nil
}

func (s *contractAlertStore) Stats(context.Context, *string, string) (alerts.Stats, error) {
	return alerts.Stats{}, nil
}

func requestContract(handler http.HandlerFunc, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
}

func requestWithHeaders(handler http.HandlerFunc, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler(recorder, withRequestIdentity(request))
	return recorder
}

func withRequestIdentity(request *http.Request) *http.Request {
	return request.WithContext(auth.WithUserContext(request.Context(), auth.UserContextFromRequest(request)))
}

func requestContractWithParam(handler http.HandlerFunc, path, key, value string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	request = request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	return recorder
}

func assertContractJSON(t *testing.T, handler http.HandlerFunc, path string, status int, want map[string]any) {
	t.Helper()
	recorder := requestContract(handler, path)
	assertStatusAndKeys(t, recorder, status, mapKeys(want))
	var got map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for key, wantValue := range want {
		if got[key] != wantValue {
			t.Errorf("%s = %#v, want %#v", key, got[key], wantValue)
		}
	}
}

func assertStatusAndKeys(t *testing.T, recorder *httptest.ResponseRecorder, status int, keys []string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, status, recorder.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, key := range keys {
		if _, ok := got[key]; !ok {
			t.Errorf("response missing %q: %s", key, recorder.Body.String())
		}
	}
}

func assertStatusAndBody(t *testing.T, recorder *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, status, recorder.Body.String())
	}
	if got := recorder.Body.String(); got != body {
		t.Errorf("body = %s, want %s", got, body)
	}
}

func mapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func fixedNow() time.Time { return time.Unix(1793062800, 0).UTC() }

func ptr(value string) *string { return &value }

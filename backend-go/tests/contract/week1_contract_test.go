package contract

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
)

// These are handler-level contract fixtures. They intentionally do not require
// FastAPI, Redis, or PostgreSQL; live semantic diffing is a documented skip.
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
	handler.GetProfile(recorder, request)
	assertStatusAndKeys(t, recorder, http.StatusOK, []string{
		"id", "email", "name", "full_name", "is_admin", "is_active", "role_type",
		"avatar_url", "password_changed_at", "created_at", "updated_at",
	})

	notFound := profile.NewHandler(&contractProfileStore{})
	request = httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
	request.Header.Set("X-User-Id", "missing")
	recorder = httptest.NewRecorder()
	notFound.GetProfile(recorder, request)
	assertStatusAndBody(t, recorder, http.StatusNotFound, `{"detail":"User not found"}`)
}

func TestWeek1LiveFastAPIDiffSkipped(t *testing.T) {
	t.Skip("live FastAPI/Go semantic diff intentionally skipped; offline fixture contracts run above")
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

func requestContract(handler http.HandlerFunc, path string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, path, nil))
	return recorder
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

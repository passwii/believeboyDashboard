package contract

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const liveTrustedProxySecret = "live-contract-proxy-secret"

const (
	liveProjectName       = "__live_contract_project__"
	liveNotificationTitle = "__live_contract_notification__"
	liveExchangeCurrency  = "LVC"
	liveExchangeYearMonth = "2026-10"
	liveProfileEmail      = "test_admin@believeboy.com"
)

type liveContractConfig struct {
	fastAPIOrigin string
	databaseURL   string
	apiKey        string
	redisURL      string
}

type liveFixture struct {
	notificationUserID string
	projectID          string
	exchangeRateID     string
	profileUserID      string
}

func TestWeek1LiveContractFastAPIAgainstGo(t *testing.T) {
	cfg := liveConfig(t)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, cfg.databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("test database unavailable: %v", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	healthRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		cfg.fastAPIOrigin+"/api/v1/health/live",
		nil,
	)
	if err != nil {
		t.Fatalf("build FastAPI health request: %v", err)
	}
	healthResponse, err := client.Do(healthRequest)
	if err != nil {
		t.Fatalf("FastAPI unavailable at %s: %v", cfg.fastAPIOrigin, err)
	}
	_ = healthResponse.Body.Close()
	if healthResponse.StatusCode != http.StatusOK {
		t.Fatalf("FastAPI health status = %d, want 200", healthResponse.StatusCode)
	}

	goServer := newLiveGoServer(t, cfg, pool)
	fixture := loadLiveFixture(t, ctx, pool)
	baseHeaders := map[string]string{
		"X-API-Key":              cfg.apiKey,
		"X-Trusted-Proxy-Secret": liveTrustedProxySecret,
	}
	notificationHeaders := cloneHeaders(baseHeaders)
	notificationHeaders["X-User-Id"] = fixture.notificationUserID
	alertAdminHeaders := cloneHeaders(baseHeaders)
	alertAdminHeaders["X-Is-Admin"] = "true"
	alertOperatorHeaders := cloneHeaders(baseHeaders)
	alertOperatorHeaders["X-Operator"] = "live-contract-operator"
	alertOperatorHeaders["X-Is-Admin"] = "false"
	profileHeaders := cloneHeaders(baseHeaders)
	profileHeaders["X-User-Id"] = fixture.profileUserID

	alertProjectFilters := url.Values{
		"project_id": []string{fixture.projectID},
		"metric":     []string{"acos"},
		"is_active":  []string{"true"},
	}
	alertEventFilters := url.Values{
		"project_id": []string{fixture.projectID},
		"severity":   []string{"warning"},
		"status":     []string{"active"},
		"page":       []string{"1"},
		"page_size":  []string{"100"},
	}

	cases := []struct {
		name    string
		route   string
		path    string
		headers map[string]string
	}{
		{
			name:    "health",
			route:   "/api/v1/health",
			path:    "/api/v1/health",
			headers: baseHeaders,
		},
		{
			name:    "health live",
			route:   "/api/v1/health/live",
			path:    "/api/v1/health/live",
			headers: baseHeaders,
		},
		{
			name:    "health ready",
			route:   "/api/v1/health/ready",
			path:    "/api/v1/health/ready",
			headers: baseHeaders,
		},
		{
			name:  "exchange rates list",
			route: "/api/v1/exchange-rates",
			path: "/api/v1/exchange-rates?" + url.Values{
				"currency":   []string{liveExchangeCurrency},
				"year_month": []string{liveExchangeYearMonth},
				"page":       []string{"1"},
				"page_size":  []string{"50"},
			}.Encode(),
			headers: baseHeaders,
		},
		{
			name:  "exchange rate resolve",
			route: "/api/v1/exchange-rates/resolve",
			path: "/api/v1/exchange-rates/resolve?" + url.Values{
				"currency":   []string{liveExchangeCurrency},
				"year_month": []string{liveExchangeYearMonth},
			}.Encode(),
			headers: baseHeaders,
		},
		{
			name:    "exchange rate options",
			route:   "/api/v1/exchange-rates/options",
			path:    "/api/v1/exchange-rates/options",
			headers: baseHeaders,
		},
		{
			name:    "exchange rate detail",
			route:   "/api/v1/exchange-rates/{exchange_rate_id}",
			path:    "/api/v1/exchange-rates/" + fixture.exchangeRateID,
			headers: baseHeaders,
		},
		{
			name:  "notifications list",
			route: "/api/v1/notifications",
			path: "/api/v1/notifications?" + url.Values{
				"type":      []string{"alert"},
				"read":      []string{"false"},
				"page":      []string{"1"},
				"page_size": []string{"100"},
			}.Encode(),
			headers: notificationHeaders,
		},
		{
			name:    "notifications unread count",
			route:   "/api/v1/notifications/unread-count",
			path:    "/api/v1/notifications/unread-count",
			headers: notificationHeaders,
		},
		{
			name:    "alert metrics",
			route:   "/api/v1/alerts/metrics",
			path:    "/api/v1/alerts/metrics",
			headers: baseHeaders,
		},
		{
			name:    "alert rules",
			route:   "/api/v1/alerts/rules",
			path:    "/api/v1/alerts/rules?" + alertProjectFilters.Encode(),
			headers: alertAdminHeaders,
		},
		{
			name:    "alert events",
			route:   "/api/v1/alerts/events",
			path:    "/api/v1/alerts/events?" + alertEventFilters.Encode(),
			headers: alertAdminHeaders,
		},
		{
			name:  "alert stats with project",
			route: "/api/v1/alerts/stats",
			path: "/api/v1/alerts/stats?" + url.Values{
				"project_id": []string{fixture.projectID},
			}.Encode(),
			headers: alertAdminHeaders,
		},
		{
			name:    "alert stats global non-admin",
			route:   "/api/v1/alerts/stats",
			path:    "/api/v1/alerts/stats",
			headers: alertOperatorHeaders,
		},
		{
			name:    "profile",
			route:   "/api/v1/system-management/profile",
			path:    "/api/v1/system-management/profile",
			headers: profileHeaders,
		},
	}

	coveredRoutes := make(map[string]bool)
	for _, liveCase := range cases {
		liveCase := liveCase
		t.Run(liveCase.name, func(t *testing.T) {
			fastAPIResponse := fetchLiveJSON(t, client, cfg.fastAPIOrigin+liveCase.path, liveCase.headers)
			goResponse := fetchLiveJSON(t, client, goServer.URL+liveCase.path, liveCase.headers)
			if fastAPIResponse.status != goResponse.status {
				t.Fatalf(
					"status mismatch: FastAPI=%d Go=%d FastAPI body=%s Go body=%s",
					fastAPIResponse.status,
					goResponse.status,
					fastAPIResponse.body,
					goResponse.body,
				)
			}
			assertLiveJSONEqual(t, fastAPIResponse.value, goResponse.value)
			t.Logf(
				"contract matched: %s status=%d FastAPI bytes=%d Go bytes=%d",
				liveCase.route,
				fastAPIResponse.status,
				len(fastAPIResponse.body),
				len(goResponse.body),
			)
		})
		coveredRoutes[liveCase.route] = true
	}

	if len(coveredRoutes) != 14 {
		t.Fatalf("covered %d Week 1 GET routes, want 14", len(coveredRoutes))
	}
	routes := make([]string, 0, len(coveredRoutes))
	for route := range coveredRoutes {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	t.Logf(
		"Week 1 live contract coverage: %d routes / %d cases\n%s",
		len(routes),
		len(cases),
		strings.Join(routes, "\n"),
	)
}

func liveConfig(t *testing.T) liveContractConfig {
	t.Helper()
	cfg := liveContractConfig{
		fastAPIOrigin: strings.TrimRight(strings.TrimSpace(os.Getenv("FASTAPI_ORIGIN")), "/"),
		databaseURL:   strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL")),
		apiKey:        strings.TrimSpace(os.Getenv("LIVE_CONTRACT_API_KEY")),
		redisURL:      strings.TrimSpace(os.Getenv("REDIS_URL")),
	}
	if cfg.redisURL == "" {
		host := strings.TrimSpace(os.Getenv("REDIS_HOST"))
		if host != "" {
			port := strings.TrimSpace(os.Getenv("REDIS_PORT"))
			if port == "" {
				port = "6379"
			}
			database := strings.TrimSpace(os.Getenv("REDIS_DB"))
			if database == "" {
				database = "0"
			}
			cfg.redisURL = fmt.Sprintf("redis://%s:%s/%s", host, port, database)
		}
	}

	missing := make([]string, 0, 3)
	if cfg.fastAPIOrigin == "" {
		missing = append(missing, "FASTAPI_ORIGIN")
	}
	if cfg.databaseURL == "" {
		missing = append(missing, "GO_API_TEST_DATABASE_URL")
	}
	if cfg.apiKey == "" {
		missing = append(missing, "LIVE_CONTRACT_API_KEY")
	}
	required := liveContractRequired()
	if len(missing) > 0 {
		message := "live contract requires " + strings.Join(missing, ", ")
		if required {
			t.Fatal(message)
		}
		if len(missing) < 3 {
			t.Fatalf("incomplete live contract environment: %s", message)
		}
		t.Skip(message + " (set LIVE_CONTRACT_REQUIRED=1 to make this a gate)")
	}
	return cfg
}

func liveContractRequired() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LIVE_CONTRACT_REQUIRED"))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

func TestLiveContractRequiredFlag(t *testing.T) {
	tests := []struct {
		value string
		want  bool
	}{
		{value: "", want: false},
		{value: "0", want: false},
		{value: "1", want: true},
		{value: "true", want: true},
		{value: "YES", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			t.Setenv("LIVE_CONTRACT_REQUIRED", tt.value)
			if got := liveContractRequired(); got != tt.want {
				t.Errorf("liveContractRequired(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

func newLiveGoServer(
	t *testing.T,
	cfg liveContractConfig,
	pool *pgxpool.Pool,
) *httptest.Server {
	t.Helper()
	db := store.NewPGXDB(pool)
	stores := httpserver.OwnedStores{
		APIKeys:        store.NewUserKeyStore(db),
		HealthDatabase: db,
		ExchangeRates:  store.NewExchangeRateStore(db),
		Notifications:  store.NewNotificationStore(db),
		Alerts:         store.NewAlertStore(db),
		Profile:        store.NewProfileStore(db),
	}
	if cfg.redisURL != "" {
		redisClient := health.NewRedisClient(cfg.redisURL)
		if redisClient == nil {
			t.Fatalf("parse REDIS_URL %q", cfg.redisURL)
		}
		probe := health.NewRedisProbe(redisClient, nil)
		stores.HealthRedis = probe
		t.Cleanup(func() {
			_ = probe.Close()
		})
	}

	router, err := httpserver.NewRouter(
		config.Config{
			FastAPIOrigin:      cfg.fastAPIOrigin,
			APIKey:             cfg.apiKey,
			TrustedProxySecret: liveTrustedProxySecret,
			DatabaseURL:        cfg.databaseURL,
			RedisURL:           cfg.redisURL,
			AppEnv:             strings.TrimSpace(os.Getenv("APP_ENV")),
			OwnedModules: map[string]bool{
				"health":         true,
				"exchange_rates": true,
				"notifications":  true,
				"alerts":         true,
				"profile":        true,
			},
		},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		stores,
	)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func loadLiveFixture(t *testing.T, ctx context.Context, db rowQuerier) liveFixture {
	t.Helper()
	fixture := liveFixture{}
	if err := db.QueryRow(
		ctx,
		"select user_id::text from public.notifications where title = $1",
		liveNotificationTitle,
	).Scan(&fixture.notificationUserID); err != nil {
		t.Fatalf("load live notification fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.projects where project_name = $1",
		liveProjectName,
	).Scan(&fixture.projectID); err != nil {
		t.Fatalf("load live project fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		`select id::text
		 from public.exchange_rates
		 where currency = $1 and year_month = $2`,
		liveExchangeCurrency,
		liveExchangeYearMonth,
	).Scan(&fixture.exchangeRateID); err != nil {
		t.Fatalf("load live exchange-rate fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		`select id::text
		 from public.user_accounts
		 where lower(email) = lower($1)
		 limit 1`,
		liveProfileEmail,
	).Scan(&fixture.profileUserID); err != nil {
		t.Fatalf("load live profile fixture: %v", err)
	}
	return fixture
}

func cloneHeaders(source map[string]string) map[string]string {
	cloned := make(map[string]string, len(source)+2)
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

type liveResponse struct {
	status int
	body   []byte
	value  any
}

func fetchLiveJSON(
	t *testing.T,
	client *http.Client,
	target string,
	headers map[string]string,
) liveResponse {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		t.Fatalf("build request %s: %v", target, err)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("request %s: %v", target, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s: %v", target, err)
	}
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode %s response %q: %v", target, body, err)
	}
	return liveResponse{
		status: response.StatusCode,
		body:   body,
		value:  normalizeLiveJSON(value),
	}
}

func normalizeLiveJSON(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			switch key {
			case "timestamp":
				// Health probes run at slightly different instants.
				result[key] = "<runtime>"
			case "redis":
				if status, ok := item.(string); ok && strings.HasPrefix(status, "ok (") {
					result[key] = "ok"
				} else {
					result[key] = normalizeLiveJSON(item)
				}
			case "redis_memory":
				// Redis reports process-wide memory, which can move between calls.
				if item == nil {
					result[key] = nil
				} else {
					result[key] = "<runtime>"
				}
			default:
				result[key] = normalizeLiveJSON(item)
			}
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = normalizeLiveJSON(item)
		}
		return result
	case json.Number:
		number, err := typed.Float64()
		if err != nil {
			return typed.String()
		}
		return number
	default:
		return value
	}
}

func assertLiveJSONEqual(t *testing.T, want, got any) {
	t.Helper()
	switch typedWant := want.(type) {
	case map[string]any:
		typedGot, ok := got.(map[string]any)
		if !ok {
			t.Fatalf("JSON type mismatch: FastAPI map, Go %T", got)
		}
		if len(typedWant) != len(typedGot) {
			t.Fatalf("JSON key count mismatch: FastAPI=%v Go=%v", typedWant, typedGot)
		}
		for key, wantValue := range typedWant {
			gotValue, present := typedGot[key]
			if !present {
				t.Fatalf("Go response missing key %q", key)
			}
			assertLiveJSONEqual(t, wantValue, gotValue)
		}
	case []any:
		typedGot, ok := got.([]any)
		if !ok {
			t.Fatalf("JSON type mismatch: FastAPI array, Go %T", got)
		}
		if len(typedWant) != len(typedGot) {
			t.Fatalf("array length mismatch: FastAPI=%d Go=%d", len(typedWant), len(typedGot))
		}
		for index := range typedWant {
			assertLiveJSONEqual(t, typedWant[index], typedGot[index])
		}
	case float64:
		typedGot, ok := got.(float64)
		if !ok {
			t.Fatalf("number type mismatch: FastAPI=number Go=%T", got)
		}
		tolerance := math.Max(1e-9, math.Abs(typedWant)*1e-9)
		if math.Abs(typedWant-typedGot) > tolerance {
			t.Fatalf("number mismatch: FastAPI=%v Go=%#v", typedWant, got)
		}
	case string:
		typedGot, ok := got.(string)
		if !ok {
			t.Fatalf("string mismatch: FastAPI=%q Go=%#v", typedWant, got)
		}
		wantTime, wantErr := time.Parse(time.RFC3339Nano, typedWant)
		gotTime, gotErr := time.Parse(time.RFC3339Nano, typedGot)
		if wantErr == nil && gotErr == nil {
			if math.Abs(wantTime.Sub(gotTime).Seconds()) > 1 {
				t.Fatalf("timestamp mismatch: FastAPI=%q Go=%q", typedWant, typedGot)
			}
			return
		}
		if typedWant != typedGot {
			t.Fatalf("string mismatch: FastAPI=%q Go=%q", typedWant, typedGot)
		}
	default:
		if want != got {
			t.Fatalf("value mismatch: FastAPI=%#v Go=%#v", want, got)
		}
	}
}

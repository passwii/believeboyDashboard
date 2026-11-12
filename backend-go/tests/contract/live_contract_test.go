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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
	"github.com/passwii/believeboyDashboard/backend-go/internal/livecontract"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const liveTrustedProxySecret = "live-contract-proxy-secret"

// goldenPath is the FastAPI recording produced by cmd/livegolden. The contract
// asserts the Go gateway against that recording instead of a live FastAPI
// process, so CI no longer needs a Python runtime to prove parity.
const goldenPath = "testdata/week1_live_golden.json"

type liveContractConfig struct {
	databaseURL string
	apiKey      string
	redisURL    string
}

func TestWeek1LiveContractAgainstGolden(t *testing.T) {
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

	golden := loadGolden(t)
	goServer := newLiveGoServer(t, cfg, pool)
	fixtures := loadLiveFixture(t, ctx, pool)
	cases := livecontract.BuildCases(fixtures)
	if len(cases) != len(golden.Cases) {
		t.Fatalf("case count mismatch: code=%d golden=%d (re-record with cmd/livegolden)", len(cases), len(golden.Cases))
	}

	client := &http.Client{Timeout: 10 * time.Second}
	baseHeaders := map[string]string{
		"X-API-Key":              cfg.apiKey,
		"X-Trusted-Proxy-Secret": liveTrustedProxySecret,
	}
	for index, goldenCase := range golden.Cases {
		liveCase := cases[index]
		if liveCase.Name != goldenCase.Name {
			t.Fatalf("case %d mismatch: code=%q golden=%q (re-record with cmd/livegolden)", index, liveCase.Name, goldenCase.Name)
		}
		liveCase, goldenCase := liveCase, goldenCase
		t.Run(goldenCase.Name, func(t *testing.T) {
			headers := cloneHeaders(baseHeaders)
			for key, value := range headersForRole(liveCase.HeaderRole, fixtures) {
				headers[key] = value
			}
			goResponse := fetchLiveJSON(t, client, goServer.URL+liveCase.RequestPath, headers)
			if goResponse.status != goldenCase.Status {
				t.Fatalf("status mismatch: golden=%d Go=%d body=%s", goldenCase.Status, goResponse.status, goResponse.body)
			}
			// Both sides are tokenized: numeric ids keep their JSON type on the
			// golden side, so comparing tokens (instead of resolving the golden
			// ids) is the only type-stable option.
			want := decodeGolden(t, goldenCase)
			got := livecontract.ApplyTokensValue(goResponse.value, fixtures)
			for _, key := range liveCase.MaskedKeys {
				deleteKey(want, key)
				deleteKey(got, key)
			}
			assertLiveJSONEqual(t, want, got)
			t.Logf("contract matched: %s status=%d", liveCase.Route, goResponse.status)
		})
	}

	routes := livecontract.DistinctRoutes(cases)
	t.Logf(
		"Week 1 live contract coverage: %d routes / %d cases\n%s",
		len(routes), len(cases), strings.Join(routes, "\n"),
	)
}

func loadGolden(t *testing.T) livecontract.GoldenFile {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join(".", goldenPath))
	if err != nil {
		t.Fatalf("read golden file: %v (regenerate with go run ./cmd/livegolden)", err)
	}
	var golden livecontract.GoldenFile
	if err := json.Unmarshal(payload, &golden); err != nil {
		t.Fatalf("decode golden file: %v", err)
	}
	if err := golden.Validate(); err != nil {
		t.Fatalf("invalid golden file: %v", err)
	}
	return golden
}

// deleteKey removes one top-level field so environment bookkeeping does not
// become part of the contract.
func deleteKey(value any, key string) {
	if object, ok := value.(map[string]any); ok {
		delete(object, key)
	}
}

func decodeGolden(t *testing.T, goldenCase livecontract.GoldenCase) any {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(goldenCase.Body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode golden body for %q: %v", goldenCase.Name, err)
	}
	return normalizeLiveJSON(value)
}

func headersForRole(role livecontract.HeaderRole, fixtures livecontract.Fixtures) map[string]string {
	headers := map[string]string{}
	switch role {
	case livecontract.RoleNotification:
		headers["X-User-Id"] = fixtures.NotificationUserID
	case livecontract.RoleAlertAdmin:
		headers["X-Is-Admin"] = "true"
	case livecontract.RoleAlertOperator:
		headers["X-Operator"] = "live-contract-operator"
		headers["X-Is-Admin"] = "false"
	case livecontract.RoleProfile:
		headers["X-User-Id"] = fixtures.ProfileUserID
	}
	return headers
}

func liveConfig(t *testing.T) liveContractConfig {
	t.Helper()
	cfg := liveContractConfig{
		databaseURL: strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL")),
		apiKey:      strings.TrimSpace(os.Getenv("LIVE_CONTRACT_API_KEY")),
		redisURL:    strings.TrimSpace(os.Getenv("REDIS_URL")),
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

	missing := make([]string, 0, 2)
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
		if len(missing) < 2 {
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
			// The router always builds a FastAPI proxy handler; this test never
			// exercises it because every selected module is owned by Go.
			FastAPIOrigin:      "http://127.0.0.1:8100",
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

func loadLiveFixture(t *testing.T, ctx context.Context, db rowQuerier) livecontract.Fixtures {
	t.Helper()
	fixtures := livecontract.Fixtures{}
	if err := db.QueryRow(
		ctx,
		"select user_id::text from public.notifications where title = $1",
		livecontract.NotificationTitle,
	).Scan(&fixtures.NotificationUserID); err != nil {
		t.Fatalf("load live notification fixture: %v (seed with go run ./cmd/seedlivecontract)", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.projects where project_name = $1",
		livecontract.ProjectName,
	).Scan(&fixtures.ProjectID); err != nil {
		t.Fatalf("load live project fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.exchange_rates where currency = $1 and year_month = $2",
		livecontract.ExchangeCurrency,
		livecontract.ExchangeYearMonth,
	).Scan(&fixtures.ExchangeRateID); err != nil {
		t.Fatalf("load live exchange-rate fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.user_accounts where lower(email) = lower($1) limit 1",
		livecontract.ProfileEmail,
	).Scan(&fixtures.ProfileUserID); err != nil {
		t.Fatalf("load live profile fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.notifications where title = $1",
		livecontract.NotificationTitle,
	).Scan(&fixtures.NotificationID); err != nil {
		t.Fatalf("load live notification id: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.alert_rules where name = $1",
		livecontract.AlertRuleName,
	).Scan(&fixtures.AlertRuleID); err != nil {
		t.Fatalf("load live alert rule fixture: %v", err)
	}
	if err := db.QueryRow(
		ctx,
		"select id::text from public.alert_events where message = $1",
		livecontract.AlertEventMessage,
	).Scan(&fixtures.AlertEventID); err != nil {
		t.Fatalf("load live alert event fixture: %v", err)
	}
	return fixtures
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
			case "version":
				// APP_ENV differs per environment, so the reported version is not
				// a contract property.
				result[key] = "<runtime>"
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
			t.Fatalf("JSON type mismatch: golden map, Go %T", got)
		}
		if len(typedWant) != len(typedGot) {
			t.Fatalf("JSON key count mismatch: golden=%v Go=%v", typedWant, typedGot)
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
			t.Fatalf("JSON type mismatch: golden array, Go %T", got)
		}
		if len(typedWant) != len(typedGot) {
			t.Fatalf("array length mismatch: golden=%d Go=%d", len(typedWant), len(typedGot))
		}
		for index := range typedWant {
			assertLiveJSONEqual(t, typedWant[index], typedGot[index])
		}
	case float64:
		typedGot, ok := got.(float64)
		if !ok {
			t.Fatalf("number type mismatch: golden=number Go=%T", got)
		}
		tolerance := math.Max(1e-9, math.Abs(typedWant)*1e-9)
		if math.Abs(typedWant-typedGot) > tolerance {
			t.Fatalf("number mismatch: golden=%v Go=%#v", typedWant, got)
		}
	case string:
		typedGot, ok := got.(string)
		if !ok {
			t.Fatalf("string mismatch: golden=%q Go=%#v", typedWant, got)
		}
		wantTime, wantErr := time.Parse(time.RFC3339Nano, typedWant)
		gotTime, gotErr := time.Parse(time.RFC3339Nano, typedGot)
		if wantErr == nil && gotErr == nil {
			if math.Abs(wantTime.Sub(gotTime).Seconds()) > 1 {
				t.Fatalf("timestamp mismatch: golden=%q Go=%q", typedWant, typedGot)
			}
			return
		}
		if typedWant != typedGot {
			t.Fatalf("string mismatch: golden=%q Go=%q", typedWant, typedGot)
		}
	default:
		if want != got {
			t.Fatalf("value mismatch: golden=%#v Go=%#v", want, got)
		}
	}
}

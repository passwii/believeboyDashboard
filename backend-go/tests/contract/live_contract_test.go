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
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpserver"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func TestWeek1LiveContractFastAPIAgainstGo(t *testing.T) {
	fastAPIOrigin := strings.TrimRight(strings.TrimSpace(os.Getenv("FASTAPI_ORIGIN")), "/")
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	apiKey := strings.TrimSpace(os.Getenv("LIVE_CONTRACT_API_KEY"))
	if fastAPIOrigin == "" || databaseURL == "" || apiKey == "" {
		t.Skip("live contract skipped: set FASTAPI_ORIGIN, GO_API_TEST_DATABASE_URL, and LIVE_CONTRACT_API_KEY")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("live contract skipped: test database unavailable: %v", err)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	healthRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		fastAPIOrigin+"/api/v1/health/live",
		nil,
	)
	if err != nil {
		t.Fatalf("build FastAPI health request: %v", err)
	}
	healthResponse, err := client.Do(healthRequest)
	if err != nil {
		t.Skipf("live contract skipped: FastAPI unavailable at %s: %v", fastAPIOrigin, err)
	}
	_ = healthResponse.Body.Close()
	if healthResponse.StatusCode != http.StatusOK {
		t.Fatalf("FastAPI health status = %d, want 200", healthResponse.StatusCode)
	}

	goServer := newLiveGoServer(t, fastAPIOrigin, apiKey, pool)
	headers := map[string]string{
		"X-API-Key": apiKey,
	}
	notificationHeaders := map[string]string{
		"X-API-Key": apiKey,
		"X-User-Id": liveNotificationUserID(t, ctx, pool),
	}
	alertHeaders := map[string]string{
		"X-API-Key":  apiKey,
		"X-Is-Admin": "true",
	}
	projectID := liveProjectID(t, ctx, pool)
	ruleFilters := liveRuleFilters(t, ctx, pool, projectID)
	eventFilters := liveEventFilters(t, ctx, pool, projectID)

	cases := []struct {
		name    string
		path    string
		headers map[string]string
	}{
		{
			name:    "notifications list",
			path:    "/api/v1/notifications?page=1&page_size=100",
			headers: notificationHeaders,
		},
		{
			name:    "notifications unread count",
			path:    "/api/v1/notifications/unread-count",
			headers: notificationHeaders,
		},
		{
			name:    "alert metrics",
			path:    "/api/v1/alerts/metrics",
			headers: headers,
		},
		{
			name:    "alert rules",
			path:    "/api/v1/alerts/rules?" + ruleFilters.Encode(),
			headers: alertHeaders,
		},
		{
			name:    "alert events",
			path:    "/api/v1/alerts/events?" + eventFilters.Encode(),
			headers: alertHeaders,
		},
		{
			name: "alert stats",
			path: "/api/v1/alerts/stats?" + url.Values{
				"project_id": []string{projectID},
			}.Encode(),
			headers: alertHeaders,
		},
	}
	for _, liveCase := range cases {
		t.Run(liveCase.name, func(t *testing.T) {
			fastAPIResponse := fetchLiveJSON(t, client, fastAPIOrigin+liveCase.path, liveCase.headers)
			goResponse := fetchLiveJSON(t, client, goServer.URL+liveCase.path, liveCase.headers)
			if fastAPIResponse.status != goResponse.status {
				t.Fatalf(
					"status mismatch: FastAPI=%d go=%d FastAPI body=%s Go body=%s",
					fastAPIResponse.status,
					goResponse.status,
					fastAPIResponse.body,
					goResponse.body,
				)
			}
			assertLiveJSONEqual(t, fastAPIResponse.value, goResponse.value)
		})
	}
}

func newLiveGoServer(
	t *testing.T,
	fastAPIOrigin string,
	apiKey string,
	pool *pgxpool.Pool,
) *httptest.Server {
	t.Helper()
	db := store.NewPGXDB(pool)
	router, err := httpserver.NewRouter(
		config.Config{
			FastAPIOrigin: fastAPIOrigin,
			APIKey:        apiKey,
			OwnedModules: map[string]bool{
				"notifications": true,
				"alerts":        true,
			},
		},
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		httpserver.OwnedStores{
			Notifications: store.NewNotificationStore(db),
			Alerts:        store.NewAlertStore(db),
		},
	)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return server
}

func liveNotificationUserID(t *testing.T, ctx context.Context, db rowQuerier) string {
	t.Helper()
	var userID string
	err := db.QueryRow(
		ctx,
		"select user_id::text from public.notifications order by id limit 1",
	).Scan(&userID)
	if err == pgx.ErrNoRows {
		t.Skip("live contract skipped: no notification fixture in test database")
	}
	if err != nil {
		t.Fatalf("load notification fixture: %v", err)
	}
	return userID
}

func liveProjectID(t *testing.T, ctx context.Context, db rowQuerier) string {
	t.Helper()
	var projectID string
	err := db.QueryRow(
		ctx,
		"select id::text from public.projects order by id limit 1",
	).Scan(&projectID)
	if err == pgx.ErrNoRows {
		t.Skip("live contract skipped: no project fixture in test database")
	}
	if err != nil {
		t.Fatalf("load project fixture: %v", err)
	}
	return projectID
}

func liveRuleFilters(
	t *testing.T,
	ctx context.Context,
	db rowQuerier,
	fallbackProjectID string,
) url.Values {
	t.Helper()
	values := url.Values{"project_id": []string{fallbackProjectID}}
	var projectID, metric string
	var isActive bool
	err := db.QueryRow(
		ctx,
		`select project_id::text, metric, is_active
		 from public.alert_rules
		 order by id
		 limit 1`,
	).Scan(&projectID, &metric, &isActive)
	if err == nil {
		values.Set("project_id", projectID)
		values.Set("metric", metric)
		values.Set("is_active", fmt.Sprintf("%t", isActive))
		return values
	}
	if err != pgx.ErrNoRows {
		t.Fatalf("load rule fixture: %v", err)
	}
	values.Set("is_active", "true")
	return values
}

func liveEventFilters(
	t *testing.T,
	ctx context.Context,
	db rowQuerier,
	fallbackProjectID string,
) url.Values {
	t.Helper()
	values := url.Values{
		"project_id": []string{fallbackProjectID},
		"page":       []string{"1"},
		"page_size":  []string{"100"},
	}
	var projectID, severity, status string
	err := db.QueryRow(
		ctx,
		`select project_id::text, severity, status
		 from public.alert_events
		 order by id
		 limit 1`,
	).Scan(&projectID, &severity, &status)
	if err == nil {
		values.Set("project_id", projectID)
		values.Set("severity", severity)
		values.Set("status", status)
		return values
	}
	if err != pgx.ErrNoRows {
		t.Fatalf("load event fixture: %v", err)
	}
	return values
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
			result[key] = normalizeLiveJSON(item)
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
		if !ok || typedWant != typedGot {
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

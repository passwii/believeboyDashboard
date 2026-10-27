package httpserver

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestOwnedModulesFallBackIndependently(t *testing.T) {
	tests := []struct {
		name       string
		owned      map[string]bool
		path       string
		apiKey     string
		userHeader string
		wantGo     bool
	}{
		{
			name:   "health disabled",
			owned:  map[string]bool{"exchange_rates": true, "profile": true},
			path:   "/api/v1/health/live",
			wantGo: false,
		},
		{
			name:   "exchange rates disabled",
			owned:  map[string]bool{"health": true, "profile": true},
			path:   "/api/v1/exchange-rates",
			apiKey: "test-api-key",
			wantGo: false,
		},
		{
			name:       "profile disabled",
			owned:      map[string]bool{"health": true, "exchange_rates": true},
			path:       "/api/v1/system-management/profile",
			apiKey:     "test-api-key",
			userHeader: "user-123",
			wantGo:     false,
		},
		{
			name:   "health enabled",
			owned:  map[string]bool{"health": true},
			path:   "/api/v1/health/live",
			wantGo: true,
		},
		{
			name:   "exchange rates enabled",
			owned:  map[string]bool{"exchange_rates": true},
			path:   "/api/v1/exchange-rates/options",
			apiKey: "test-api-key",
			wantGo: true,
		},
		{
			name:       "profile enabled",
			owned:      map[string]bool{"profile": true},
			path:       "/api/v1/system-management/profile",
			apiKey:     "test-api-key",
			userHeader: "user-123",
			wantGo:     true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var upstreamHit atomic.Bool
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				upstreamHit.Store(true)
				_, _ = w.Write([]byte("fastapi"))
			}))
			t.Cleanup(upstream.Close)

			router := newOwnedTestRouter(t, upstream.URL, tt.owned)
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			if tt.apiKey != "" {
				req.Header.Set("X-API-Key", tt.apiKey)
			}
			if tt.userHeader != "" {
				req.Header.Set("X-User-Id", tt.userHeader)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if tt.wantGo {
				t.Logf("status=%d body=%s", rec.Code, rec.Body.String())
				if upstreamHit.Load() {
					t.Error("FastAPI fallback was called for an owned route")
				}
				if rec.Body.String() == "fastapi" {
					t.Error("response body came from fallback")
				}
				return
			}
			if !upstreamHit.Load() {
				t.Error("FastAPI fallback was not called for a disabled module")
			}
			if rec.Body.String() != "fastapi" {
				t.Errorf("body = %q, want fallback body", rec.Body.String())
			}
		})
	}
}

func TestOwnedExchangeRateStaticRoutesPrecedeIDRoute(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fastapi"))
	}))
	t.Cleanup(upstream.Close)
	router := newOwnedTestRouter(t, upstream.URL, map[string]bool{"exchange_rates": true})

	for _, path := range []string{
		"/api/v1/exchange-rates/resolve?currency=USD&year_month=2026-10",
		"/api/v1/exchange-rates/options",
	} {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			req.Header.Set("X-API-Key", "test-api-key")
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Body.String() == "fastapi" {
				t.Errorf("body = %q, static route fell through", rec.Body.String())
			}
			_ = rec.Code
		})
	}
}

func TestOwnedRoutesOnlyProtectMigratedGETPaths(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fastapi"))
	}))
	t.Cleanup(upstream.Close)
	router := newOwnedTestRouter(t, upstream.URL, map[string]bool{
		"health":         true,
		"exchange_rates": true,
		"profile":        true,
	})

	tests := []struct {
		name       string
		method     string
		path       string
		headers    map[string]string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "live unauthenticated",
			method:     http.MethodGet,
			path:       "/api/v1/health/live",
			wantStatus: http.StatusOK,
		},
		{
			name:       "ready unauthenticated",
			method:     http.MethodGet,
			path:       "/api/v1/health/ready",
			wantStatus: http.StatusOK,
		},
		{
			name:       "health protected",
			method:     http.MethodGet,
			path:       "/api/v1/health",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "exchange rates protected",
			method:     http.MethodGet,
			path:       "/api/v1/exchange-rates/options",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "profile protected",
			method:     http.MethodGet,
			path:       "/api/v1/system-management/profile",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:   "exchange rate write remains proxied",
			method: http.MethodPost,
			path:   "/api/v1/exchange-rates",
			headers: map[string]string{
				"Content-Type": "application/json",
			},
			wantStatus: http.StatusOK,
			wantBody:   "fastapi",
		},
		{
			name:       "profile patch remains proxied",
			method:     http.MethodPatch,
			path:       "/api/v1/system-management/profile",
			wantStatus: http.StatusOK,
			wantBody:   "fastapi",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, tt.path, nil)
			for key, value := range tt.headers {
				req.Header.Set(key, value)
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d; body = %s", rec.Code, tt.wantStatus, rec.Body.String())
			}
			if tt.wantBody != "" && rec.Body.String() != tt.wantBody {
				t.Errorf("body = %q, want %q", rec.Body.String(), tt.wantBody)
			}
		})
	}
}

func newOwnedTestRouter(t *testing.T, upstreamURL string, owned map[string]bool) chiRouter {
	t.Helper()
	router, err := NewRouter(config.Config{
		Addr:            "127.0.0.1:8200",
		FastAPIOrigin:   upstreamURL,
		APIKey:          "test-api-key",
		DatabaseURL:     "postgres://localhost/test",
		DatabaseReadURL: "",
		RedisURL:        "redis://localhost:6379/0",
		AppEnv:          "test",
		OwnedModules:    owned,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), OwnedStores{
		APIKeys:        &stubKeyResolver{},
		HealthDatabase: stubPinger{},
		ExchangeRates:  stubExchangeStore{},
		Profile:        stubProfileStore{},
	})
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	return router
}

type chiRouter interface {
	http.Handler
}

type stubExchangeStore struct{}

func (stubExchangeStore) List(context.Context, *string, *string, int, int) ([]exchange_rates.ExchangeRate, int, error) {
	return nil, 0, nil
}
func (stubExchangeStore) Resolve(context.Context, string, string) (*exchange_rates.ExchangeRate, error) {
	return nil, nil
}
func (stubExchangeStore) ListOptionRows(context.Context) ([]exchange_rates.ExchangeRate, error) {
	return nil, nil
}
func (stubExchangeStore) Get(context.Context, int64) (*exchange_rates.ExchangeRate, error) {
	return nil, nil
}

type stubProfileStore struct{}

func (stubProfileStore) GetByUserID(context.Context, string) (*profile.Profile, error) {
	return nil, nil
}

var _ health.Pinger = stubPinger{}
var _ exchange_rates.Store = stubExchangeStore{}
var _ profile.Store = stubProfileStore{}

type stubPinger struct{}

func (stubPinger) Ping(context.Context) error { return nil }

type stubKeyResolver struct{}

func (*stubKeyResolver) ResolveUserKey(context.Context, string) (*auth.UserKeyRecord, error) {
	return nil, nil
}

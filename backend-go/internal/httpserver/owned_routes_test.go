package httpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/alerts"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/health"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/notifications"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

const testTrustedProxySecret = "test-proxy-secret"

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
			owned:  map[string]bool{"exchange_rates": true, "notifications": true, "alerts": true, "profile": true},
			path:   "/api/v1/health/live",
			wantGo: false,
		},
		{
			name:   "exchange rates disabled",
			owned:  map[string]bool{"health": true, "notifications": true, "alerts": true, "profile": true},
			path:   "/api/v1/exchange-rates",
			apiKey: "test-api-key",
			wantGo: false,
		},
		{
			name:       "notifications disabled",
			owned:      map[string]bool{"health": true, "exchange_rates": true, "alerts": true, "profile": true},
			path:       "/api/v1/notifications",
			apiKey:     "test-api-key",
			userHeader: "1",
			wantGo:     false,
		},
		{
			name:   "alerts disabled",
			owned:  map[string]bool{"health": true, "exchange_rates": true, "notifications": true, "profile": true},
			path:   "/api/v1/alerts/metrics",
			apiKey: "test-api-key",
			wantGo: false,
		},
		{
			name:       "profile disabled",
			owned:      map[string]bool{"health": true, "exchange_rates": true, "notifications": true, "alerts": true},
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
			name:       "notifications enabled",
			owned:      map[string]bool{"notifications": true},
			path:       "/api/v1/notifications",
			apiKey:     "test-api-key",
			userHeader: "1",
			wantGo:     true,
		},
		{
			name:   "alerts enabled",
			owned:  map[string]bool{"alerts": true},
			path:   "/api/v1/alerts/metrics",
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
				req.Header.Set(auth.TrustedProxySecretHeader, testTrustedProxySecret)
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
			req.Header.Set(auth.TrustedProxySecretHeader, testTrustedProxySecret)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if rec.Body.String() == "fastapi" {
				t.Errorf("body = %q, static route fell through", rec.Body.String())
			}
			_ = rec.Code
		})
	}
}

func TestOwnedNotificationAndAlertRoutesRequireAPIKeyAndWritesStayProxied(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fastapi"))
	}))
	t.Cleanup(upstream.Close)
	router := newOwnedTestRouter(t, upstream.URL, map[string]bool{
		"notifications": true,
		"alerts":        true,
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
			name:       "notifications protected",
			method:     http.MethodGet,
			path:       "/api/v1/notifications",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "unread count protected",
			method:     http.MethodGet,
			path:       "/api/v1/notifications/unread-count",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "alert rules protected",
			method:     http.MethodGet,
			path:       "/api/v1/alerts/rules",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "alert events protected",
			method:     http.MethodGet,
			path:       "/api/v1/alerts/events",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "alert stats protected",
			method:     http.MethodGet,
			path:       "/api/v1/alerts/stats",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "alert metrics protected",
			method:     http.MethodGet,
			path:       "/api/v1/alerts/metrics",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
		},
		{
			name:       "mark all read write remains proxied",
			method:     http.MethodPost,
			path:       "/api/v1/notifications/read-all",
			wantStatus: http.StatusOK,
			wantBody:   "fastapi",
		},
		{
			name:       "create rule write remains proxied",
			method:     http.MethodPost,
			path:       "/api/v1/alerts/rules",
			headers:    map[string]string{"Content-Type": "application/json"},
			wantStatus: http.StatusOK,
			wantBody:   "fastapi",
		},
		{
			name:       "acknowledge write remains proxied",
			method:     http.MethodPost,
			path:       "/api/v1/alerts/events/1/acknowledge",
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
			if rec.Body.String() != tt.wantBody {
				t.Errorf("body = %q, want %q", rec.Body.String(), tt.wantBody)
			}
		})
	}
}

func TestOwnedAlertMetricsReturnsStaticPayload(t *testing.T) {
	var upstreamHit atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamHit.Store(true)
		_, _ = w.Write([]byte("fastapi"))
	}))
	t.Cleanup(upstream.Close)
	router := newOwnedTestRouter(t, upstream.URL, map[string]bool{"alerts": true})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/metrics", nil)
	req.Header.Set("X-API-Key", "test-api-key")
	req.Header.Set(auth.TrustedProxySecretHeader, testTrustedProxySecret)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if upstreamHit.Load() {
		t.Error("FastAPI fallback was called for alerts/metrics")
	}
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"reconciliation_mismatch"`) {
		t.Errorf("response = %d %s, want static metrics", rec.Code, rec.Body.String())
	}
}

func TestOwnedRoutesOnlyProtectMigratedPaths(t *testing.T) {
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
			name:       "profile patch protected",
			method:     http.MethodPatch,
			path:       "/api/v1/system-management/profile",
			wantStatus: http.StatusUnauthorized,
			wantBody:   `{"detail":"Missing API key"}`,
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

func TestOwnedRoutesBindDeviceKeyIdentityAndIgnoreForgedHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("fastapi"))
	}))
	t.Cleanup(upstream.Close)

	const (
		profileKey      = "blf_profile-device-key"
		notificationKey = "blf_notification-device-key"
		alertKey        = "blf_alert-device-key"
		authoritativeID = "authoritative-user"
		notificationID  = "10"
		authorizedOwner = "owner"
		forgedUserID    = "victim-user"
	)
	resolver := &mappingKeyResolver{records: map[string]*auth.UserKeyRecord{
		deviceKeyHash(profileKey): {
			UserID: authoritativeID,
		},
		deviceKeyHash(notificationKey): {
			UserID: notificationID,
		},
		deviceKeyHash(alertKey): {
			UserID:   authoritativeID,
			FullName: authorizedOwner,
		},
	}}
	profileStore := &recordingProfileStore{rows: map[string]*profile.Profile{
		authoritativeID: {ID: authoritativeID, Email: "owner@example.com", Name: "owner"},
		forgedUserID:    {ID: forgedUserID, Email: "victim@example.com", Name: "victim"},
	}}
	notificationStore := &recordingNotificationStore{}
	alertStore := &recordingAlertStore{
		project: &alerts.Project{ProjectOperator: stringPointer(authorizedOwner)},
	}
	router := newOwnedTestRouterWithStores(
		t,
		upstream.URL,
		map[string]bool{"profile": true, "notifications": true, "alerts": true},
		OwnedStores{
			APIKeys:       resolver,
			Profile:       profileStore,
			Notifications: notificationStore,
			Alerts:        alertStore,
		},
	)

	t.Run("profile", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/system-management/profile", nil)
		req.Header.Set("X-API-Key", profileKey)
		req.Header.Set("X-User-Id", forgedUserID)
		req.Header.Set("X-Is-Admin", "true")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
		}
		if profileStore.lastUserID != authoritativeID {
			t.Fatalf("profile lookup user = %q, want device-key owner", profileStore.lastUserID)
		}
		if !strings.Contains(rec.Body.String(), `"id":"`+authoritativeID+`"`) {
			t.Errorf("body = %s, want authoritative profile", rec.Body.String())
		}
	})

	t.Run("notifications", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/notifications", nil)
		req.Header.Set("X-API-Key", notificationKey)
		req.Header.Set("X-User-Id", "20")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
		}
		if notificationStore.lastUserID != notificationID {
			t.Fatalf("notification lookup user = %q, want device-key owner", notificationStore.lastUserID)
		}
	})

	t.Run("alerts", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/rules?project_id=9", nil)
		req.Header.Set("X-API-Key", alertKey)
		req.Header.Set("X-Operator", "victim")
		req.Header.Set("X-Is-Admin", "true")
		rec := httptest.NewRecorder()

		router.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
		}
	})
}

func newOwnedTestRouter(t *testing.T, upstreamURL string, owned map[string]bool) chiRouter {
	t.Helper()
	return newOwnedTestRouterWithStores(t, upstreamURL, owned, OwnedStores{
		APIKeys:        &stubKeyResolver{},
		HealthDatabase: stubPinger{},
		ExchangeRates:  stubExchangeStore{},
		Profile:        stubProfileStore{},
		Notifications:  stubNotificationStore{},
		Alerts:         stubAlertStore{},
	})
}

func newOwnedTestRouterWithStores(
	t *testing.T,
	upstreamURL string,
	owned map[string]bool,
	stores OwnedStores,
) chiRouter {
	t.Helper()
	router, err := NewRouter(config.Config{
		Addr:               "127.0.0.1:8200",
		FastAPIOrigin:      upstreamURL,
		APIKey:             "test-api-key",
		TrustedProxySecret: testTrustedProxySecret,
		DatabaseURL:        "postgres://localhost/test",
		DatabaseReadURL:    "",
		RedisURL:           "redis://localhost:6379/0",
		AppEnv:             "test",
		OwnedModules:       owned,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), stores)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}
	return router
}

type chiRouter interface {
	http.Handler
}

type mappingKeyResolver struct {
	records map[string]*auth.UserKeyRecord
}

func (r *mappingKeyResolver) ResolveUserKey(_ context.Context, keyHash string) (*auth.UserKeyRecord, error) {
	return r.records[keyHash], nil
}

type recordingProfileStore struct {
	rows       map[string]*profile.Profile
	lastUserID string
}

func (s *recordingProfileStore) GetByUserID(_ context.Context, userID string) (*profile.Profile, error) {
	s.lastUserID = userID
	return s.rows[userID], nil
}

type recordingNotificationStore struct {
	lastUserID string
}

func (s *recordingNotificationStore) List(
	_ context.Context,
	userID string,
	_ notifications.ListParams,
) ([]notifications.Notification, int, error) {
	s.lastUserID = userID
	return nil, 0, nil
}

func (s *recordingNotificationStore) UnreadCount(_ context.Context, userID string) (int, error) {
	s.lastUserID = userID
	return 0, nil
}

type recordingAlertStore struct {
	project *alerts.Project
}

func (s *recordingAlertStore) GetProject(context.Context, string) (*alerts.Project, error) {
	return s.project, nil
}

func (s *recordingAlertStore) ListRules(context.Context, alerts.RuleFilters) ([]alerts.Rule, error) {
	return nil, nil
}

func (s *recordingAlertStore) ListEvents(context.Context, alerts.EventFilters) ([]alerts.Event, int, error) {
	return nil, 0, nil
}

func (s *recordingAlertStore) Stats(context.Context, *string, string) (alerts.Stats, error) {
	return alerts.Stats{}, nil
}

func deviceKeyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func stringPointer(value string) *string {
	return &value
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

type stubNotificationStore struct{}

func (stubNotificationStore) List(
	context.Context,
	string,
	notifications.ListParams,
) ([]notifications.Notification, int, error) {
	return nil, 0, nil
}

func (stubNotificationStore) UnreadCount(context.Context, string) (int, error) {
	return 0, nil
}

type stubAlertStore struct{}

func (stubAlertStore) GetProject(context.Context, string) (*alerts.Project, error) {
	return &alerts.Project{}, nil
}

func (stubAlertStore) ListRules(context.Context, alerts.RuleFilters) ([]alerts.Rule, error) {
	return nil, nil
}

func (stubAlertStore) ListEvents(context.Context, alerts.EventFilters) ([]alerts.Event, int, error) {
	return nil, 0, nil
}

func (stubAlertStore) Stats(context.Context, *string, string) (alerts.Stats, error) {
	return alerts.Stats{}, nil
}

var _ health.Pinger = stubPinger{}
var _ exchange_rates.Store = stubExchangeStore{}
var _ profile.Store = stubProfileStore{}
var _ notifications.Store = stubNotificationStore{}
var _ alerts.Store = stubAlertStore{}

type stubPinger struct{}

func (stubPinger) Ping(context.Context) error { return nil }

type stubKeyResolver struct{}

func (*stubKeyResolver) ResolveUserKey(context.Context, string) (*auth.UserKeyRecord, error) {
	return nil, nil
}

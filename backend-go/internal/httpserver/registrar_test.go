package httpserver

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
)

func TestCustomModuleRegistrar(t *testing.T) {
	registrar := FuncModuleRegistrar{
		Name: "custom_domain",
		Register: func(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
			router.With(requireAPIKey).Get("/api/v1/custom-endpoint", func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"module":"custom_domain"}`))
			})
		},
	}

	cfg := config.Config{
		Addr:               "127.0.0.1:8200",
		FastAPIOrigin:      "http://127.0.0.1:8100",
		APIKey:             "test-api-key",
		TrustedProxySecret: "test-proxy-secret",
		DatabaseURL:        "postgres://localhost/believeboy",
		RedisURL:           "redis://localhost:6379/0",
		OwnedModules:       map[string]bool{"custom_domain": true},
	}

	stores := OwnedStores{
		CustomRegistrars: []ModuleRegistrar{registrar},
	}

	router, err := NewRouter(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), stores)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/custom-endpoint", nil)
	req.Header.Set("X-API-Key", "test-api-key")
	req.Header.Set("X-Trusted-Proxy-Secret", "test-proxy-secret")
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"module":"custom_domain"`) {
		t.Errorf("body = %s, want custom_domain response", rec.Body.String())
	}
}

func TestCustomModuleRegistrarSkippedWhenNotOwned(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))
	defer upstream.Close()

	registrar := FuncModuleRegistrar{
		Name: "custom_domain",
		Register: func(router chi.Router, requireAPIKey func(http.Handler) http.Handler) {
			router.With(requireAPIKey).Get("/api/v1/custom-endpoint", func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"module":"custom_domain"}`))
			})
		},
	}

	cfg := config.Config{
		Addr:               "127.0.0.1:8200",
		FastAPIOrigin:      upstream.URL,
		APIKey:             "test-api-key",
		TrustedProxySecret: "test-proxy-secret",
		DatabaseURL:        "postgres://localhost/believeboy",
		RedisURL:           "redis://localhost:6379/0",
		OwnedModules:       map[string]bool{"custom_domain": false}, // Disabled!
	}

	stores := OwnedStores{
		CustomRegistrars: []ModuleRegistrar{registrar},
	}

	router, err := NewRouter(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), stores)
	if err != nil {
		t.Fatalf("NewRouter() error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/custom-endpoint", nil)
	rec := httptest.NewRecorder()

	router.ServeHTTP(rec, req)

	// Should fall back to upstream (StatusTeapot)
	if rec.Code != http.StatusTeapot {
		t.Fatalf("status = %d, want fallback 418 Teapot", rec.Code)
	}
}
